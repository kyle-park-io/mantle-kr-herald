import { describe, it, expect } from "vitest";
import { access, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { withFileLock } from "../../../src/shared/store/fileLock";

const scratch = () => mkdtemp(join(tmpdir(), "lock-"));

const exists = (path: string) => access(path).then(() => true, () => false);

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Ages a lock file into the past, standing in for a holder stalled by a suspend or a debugger. */
const backdate = async (path: string, byMs: number) => {
  const at = new Date(Date.now() - byMs);
  await utimes(path, at, at);
};

const run = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = fork(script, args, { execArgv: ["--import", "tsx"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

describe("withFileLock", () => {
  // THE test on this branch. Two real processes, one ledger: the lock is the only thing standing
  // between an interleaved read-modify-write and a dropped row — and a dropped row is a live post
  // the ledger cannot see, which the next run publishes a second time.
  it("keeps both rows when two processes append concurrently", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(path, "[]");
    const script = join(import.meta.dirname, "fileLock.child.mjs");
    await Promise.all([run(script, [path, "a", "b"]), run(script, [path, "b", "a"])]);
    expect(JSON.parse(await readFile(path, "utf8")).sort()).toEqual(["a", "b"]);
  }, 30_000);

  it("releases the lock when the job throws", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await expect(
      withFileLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A second acquisition proves the lock file is gone.
    expect(await withFileLock(path, async () => "ok")).toBe("ok");
  });

  it("releases the lock after a successful job", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await withFileLock(path, async () => "first");
    // A short timeout would expire if the previous holder had left its lock behind.
    expect(await withFileLock(path, async () => "second", { timeoutMs: 200 })).toBe("second");
  });

  it("reclaims a stale lock", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    // Backdate it well past the staleness threshold.
    await backdate(`${path}.lock`, 60_000);
    expect(await withFileLock(path, async () => "ok", { staleMs: 1_000 })).toBe("ok");
  });

  // The reclaim moves the dead lock aside with an atomic rename before deleting it. The scratch
  // file that hand-off creates must not survive the call, or every reclaim would litter the store
  // directory next to the ledger it protects.
  it("leaves nothing behind when it reclaims a stale lock", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "4821:0f8b0a3c-dead-dead-dead-000000000000\n");
    await backdate(`${path}.lock`, 60_000);
    expect(await withFileLock(path, async () => "ok", { staleMs: 1_000 })).toBe("ok");
    expect(await readdir(dir)).toEqual([]);
  });

  /**
   * REGRESSION: a holder stalled past the staleness window (suspended laptop, debugger, severe I/O
   * stall) has its lock reclaimed underneath it. When that holder finally returns, its release used
   * to `unlink` by path unconditionally — deleting the *new* holder's lock and leaving the ledger
   * disarmed for the rest of that holder's critical section, so arbitrarily many callers could walk
   * in on a plain acquire. That is the duplicate live post this module exists to prevent.
   *
   * Fully deterministic: every step is a promise hand-off, and the stall is simulated by backdating
   * the lock's mtime rather than by waiting. No sleeps, so nothing here can flake.
   */
  it("does not delete the lock of the holder that reclaimed it", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    const lock = `${path}.lock`;
    const stalledInside = deferred();
    const stalledMayExit = deferred();
    const reclaimerInside = deferred();
    const reclaimerMayExit = deferred();

    const stalled = withFileLock(path, async () => {
      stalledInside.resolve();
      await stalledMayExit.promise;
    });
    await stalledInside.promise;
    await backdate(lock, 60_000);

    const reclaimer = withFileLock(
      path,
      async () => {
        reclaimerInside.resolve();
        await reclaimerMayExit.promise;
      },
      { staleMs: 1_000, timeoutMs: 5_000 },
    );
    await reclaimerInside.promise;

    // The stalled holder wakes up and releases. The file on disk is not its lock any more.
    stalledMayExit.resolve();
    await stalled;

    expect(await exists(lock)).toBe(true);
    // The real assertion: the ledger is still armed. A third caller that cannot reclaim (its
    // staleness window is far wider than this lock's age) must be refused, which it can only be if
    // the reclaimer's lock is still there.
    await expect(
      withFileLock(path, async () => "walked in", { staleMs: 600_000, timeoutMs: 150 }),
    ).rejects.toThrow();

    reclaimerMayExit.resolve();
    await reclaimer;
  });

  // A timeout at or below the staleness window can never reclaim a dead process's lock, so every
  // run fails identically until someone deletes the file by hand. Deliberately short fail-fast
  // timeouts are legitimate, so this is diagnosed in the error rather than rejected up front.
  it("says so when the timeout cannot outlive the staleness window", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    await expect(
      withFileLock(path, async () => "never", { staleMs: 60_000, timeoutMs: 50 }),
    ).rejects.toThrow(/raise timeoutMs above staleMs/);
  });

  it("gives up rather than proceeding unprotected when the lock is held", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    await expect(
      withFileLock(path, async () => "never", { staleMs: 60_000, timeoutMs: 200 }),
    ).rejects.toThrow();
  });

  // Proceeding unprotected would turn a delay into a lost row, so the job must not run at all.
  it("does not run the job when acquisition times out", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    let ran = false;
    await expect(
      withFileLock(
        path,
        async () => {
          ran = true;
        },
        { staleMs: 60_000, timeoutMs: 200 },
      ),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });

  // Two files, two locks. One shared lock would serialize unrelated ledgers.
  it("locks each path independently", async () => {
    const dir = await scratch();
    const held = join(dir, "deliveries.json");
    const other = join(dir, "x-article.json");
    await writeFile(`${held}.lock`, "");
    expect(await withFileLock(other, async () => "ok", { staleMs: 60_000, timeoutMs: 200 })).toBe("ok");
  });

  // The atomic write creates the ledger's directory, but that happens inside the lock — so on a
  // first run the lock itself has to create it, or the very first send fails on ENOENT.
  it("locks a path whose directory does not exist yet", async () => {
    const dir = await scratch();
    const path = join(dir, "publish", "deliveries.json");
    expect(await withFileLock(path, async () => "ok")).toBe("ok");
  });

  // "Why is this stuck" should be a one-line answer, not an investigation.
  it("writes the owning pid into the lock file", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    const seen = await withFileLock(path, () => readFile(`${path}.lock`, "utf8"));
    expect(seen).toContain(String(process.pid));
  });

  it("hands the lock to a waiter once the holder releases it", async () => {
    const dir = await scratch();
    const path = join(dir, "ledger.json");
    const order: string[] = [];
    let releaseHolder!: () => void;
    const holderDone = new Promise<void>((r) => {
      releaseHolder = r;
    });
    const holder = withFileLock(path, async () => {
      order.push("holder:start");
      await holderDone;
      order.push("holder:end");
    });
    // Give the holder time to actually take the lock before the waiter arrives.
    await new Promise((r) => setTimeout(r, 20));
    const waiter = withFileLock(path, async () => {
      order.push("waiter");
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(["holder:start"]);
    releaseHolder();
    await Promise.all([holder, waiter]);
    expect(order).toEqual(["holder:start", "holder:end", "waiter"]);
  });
});
