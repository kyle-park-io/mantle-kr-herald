import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { withFileLock } from "../../../src/shared/store/fileLock";

const scratch = () => mkdtemp(join(tmpdir(), "lock-"));

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
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    expect(await withFileLock(path, async () => "ok", { staleMs: 1_000 })).toBe("ok");
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
