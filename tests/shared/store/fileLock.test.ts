import { describe, it, expect } from "vitest";
import { access, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { withFileLock } from "../../../src/shared/store/fileLock";

const scratch = () => mkdtemp(join(tmpdir(), "lock-"));

const exists = (path: string) => access(path).then(() => true, () => false);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mtimeOf = async (path: string) => (await stat(path)).mtimeMs;

/** Polls until `cond` holds, so a test never has to guess how long acquisition takes. */
const waitFor = async (cond: () => Promise<boolean>, what = "condition") => {
  for (let i = 0; i < 400; i += 1) {
    if (await cond()) return;
    await sleep(5);
  }
  throw new Error(`${what} never became true`);
};

/**
 * Runs an observation again if the wall clock jumped underneath it.
 *
 * Staleness is `Date.now() - mtime`, so a wall clock that jumps *forward* makes every lock look
 * older than it is — including one a heartbeat stamped a moment ago. That is not hypothetical here:
 * the WSL2 machine this was written on moves `Date.now()` by ~22s in bursts, measured at ~1 jump per
 * 8s during a burst and none at all for minutes either side. `performance.now()` is monotonic and
 * does not follow, so the two disagreeing is a reliable detector.
 *
 * Retrying is sound rather than lenient, and only because of the direction: the assertions guarded
 * here are negative ones ("the waiter must be refused"), which a jump can only push to a false
 * failure, never to a false pass. A real regression has no jump to point at and fails on the first
 * attempt.
 */
const withoutClockJump = async (observe: () => Promise<void>) => {
  for (let attempt = 1; ; attempt += 1) {
    const wall = Date.now();
    const mono = performance.now();
    try {
      await observe();
      return;
    } catch (err) {
      const jumped = Math.abs(Date.now() - wall - (performance.now() - mono)) > 1_000;
      if (!jumped || attempt === 3) throw err;
    }
  }
};

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

/** Reports whether a child process ended on its own, distinguishing that from having to be killed. */
const runWithin = (script: string, args: string[], ms: number) =>
  new Promise<string>((resolve, reject) => {
    const child = fork(script, args, { execArgv: ["--import", "tsx"] });
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("hung");
    }, ms);
    child.on("error", (err) => {
      clearTimeout(giveUp);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(giveUp);
      // Killed by the timer above, which has already resolved.
      if (signal) return;
      resolve(code === 0 ? "exited" : `exit ${code}`);
    });
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

  describe("heartbeat", () => {
    /**
     * The mechanism, on its own: while a job runs, its lock's mtime keeps moving. Everything below
     * depends on this, so it is asserted directly rather than only through its consequences.
     *
     * Both samples are taken *after* the first beat, deliberately. A beat stamps the mtime from
     * `Date.now()`; the mtime a file starts life with is written by the kernel. Those are two clocks,
     * and this machine has been observed disagreeing by tens of seconds for a moment at a time — so
     * comparing a beat against the creation stamp is a coin toss that has nothing to do with what is
     * being tested. Comparing two beats keeps the whole assertion inside one clock.
     */
    it("keeps stamping the lock of a holder that is still working", async () => {
      const dir = await scratch();
      const path = join(dir, "ledger.json");
      const lock = `${path}.lock`;
      const mayExit = deferred();
      // staleMs 300 puts a beat every 50ms, so the window watched below covers several.
      const holder = withFileLock(path, () => mayExit.promise, { staleMs: 300 });
      await waitFor(() => exists(lock));
      const created = await mtimeOf(lock);
      // Two changes, not one: the first proves a beat happened at all, the second that they keep
      // coming. Asserting *change* rather than *increase* is what makes this immune to the clock
      // jump described on `withoutClockJump` — nothing but a beat writes this file while it is held,
      // so any change is a beat regardless of which way the clock moved.
      await waitFor(async () => (await mtimeOf(lock)) !== created, "the first beat");
      const firstBeat = await mtimeOf(lock);
      await waitFor(async () => (await mtimeOf(lock)) !== firstBeat, "a second beat");
      mayExit.resolve();
      await holder;
    });

    /**
     * THE reason the heartbeat exists. A holder that works for longer than the staleness window used
     * to be indistinguishable from a holder that died, so the next waiter reclaimed its lock and
     * walked straight into the read-modify-write it was still running — two writers, one ledger, and
     * whichever row loses the rename becomes a live post the ledger cannot see.
     *
     * The stall is applied by backdating rather than by really sleeping for three staleness windows,
     * the same trick the reclaim regression above uses: it puts the lock in exactly the state a
     * stalled holder leaves it in, in one syscall instead of seconds, and shrinks the window in which
     * this machine's wall-clock jump could invalidate the reading. A holder with no heartbeat can
     * never get out of that state; a live one erases it on its next beat, which is what the wait
     * below is watching for and what fails first if the heartbeat is gone.
     */
    it("does not let a waiter reclaim the lock of a holder that is still working", async () => {
      const dir = await scratch();
      const path = join(dir, "ledger.json");
      const lock = `${path}.lock`;
      const mayExit = deferred();
      // staleMs 400 puts a beat every 66ms.
      const holder = withFileLock(path, () => mayExit.promise, { staleMs: 400 });
      await waitFor(() => exists(lock));
      await backdate(lock, 60_000);
      await waitFor(async () => Date.now() - (await mtimeOf(lock)) < 400, "the stall healed");
      await withoutClockJump(async () => {
        // timeoutMs above staleMs, so this is the ordinary contended path rather than the
        // misconfigured-timeout diagnostic.
        await expect(
          withFileLock(path, async () => "walked in", { staleMs: 400, timeoutMs: 500 }),
        ).rejects.toThrow(/Timed out/);
      });
      mayExit.resolve();
      await holder;
    }, 15_000);

    /**
     * The `unref`. Every caller of this module is a short-lived CLI that has to exit when its work
     * is done; a ref'd interval left armed by a hold that never settles is the only live handle and
     * hangs the command forever with no output. A real child process is the only honest way to test
     * "does this process exit" — see `fileLock.heartbeat-child.mjs` for the setup.
     */
    it("does not keep a short-lived CLI alive with its heartbeat timer", async () => {
      const dir = await scratch();
      const path = join(dir, "ledger.json");
      const script = join(import.meta.dirname, "fileLock.heartbeat-child.mjs");
      expect(await runWithin(script, [path], 10_000)).toBe("exited");
    }, 20_000);

    /**
     * Teardown on the throwing path. A released lock is deleted, so a surviving timer would usually
     * reap itself on the next beat's ENOENT — which is exactly why this probes instead of trusting
     * that: it puts the dead holder's own token back on the path, so a timer that outlived the throw
     * still recognises the file as its own and stamps it. Nothing else in the module writes here, so
     * a moved mtime can only be a heartbeat that should not still be running.
     *
     * staleMs 3_000 puts the next beat 500ms out, comfortably after the probe file is in place and
     * comfortably inside the window watched below.
     */
    it("stops the heartbeat when the job throws", async () => {
      const dir = await scratch();
      const path = join(dir, "ledger.json");
      const lock = `${path}.lock`;
      let token = "";
      await expect(
        withFileLock(
          path,
          async () => {
            token = (await readFile(lock, "utf8")).trim();
            throw new Error("boom");
          },
          { staleMs: 3_000 },
        ),
      ).rejects.toThrow("boom");

      await writeFile(lock, `${token}\n`);
      // Ages the probe so any stamp at all is unmistakable rather than a millisecond of rounding.
      await backdate(lock, 5_000);
      const before = await mtimeOf(lock);
      await sleep(900);
      expect(await mtimeOf(lock)).toBe(before);
    }, 15_000);

    /**
     * Ownership. A holder frozen past the staleness window has its lock reclaimed underneath it; if
     * its heartbeat then kept stamping the path blindly, it would keep the *successor's* lock
     * looking fresh. That is not a cosmetic mistake: should the successor die, nothing would ever
     * judge its lock stale while the original holder's timer ran, and the ledger would stay wedged
     * until someone deleted the file by hand — the heartbeat inventing the deadlock it was added to
     * prevent.
     *
     * The successor is written by hand rather than acquired by a real reclaimer, because a real one
     * runs a heartbeat of its own and then no assertion could say whose stamp it was reading.
     */
    it("does not refresh a lock it no longer owns", async () => {
      const dir = await scratch();
      const path = join(dir, "ledger.json");
      const lock = `${path}.lock`;
      const mayExit = deferred();
      // staleMs 300 puts a beat every 50ms — several inside the window watched below.
      const stalled = withFileLock(path, () => mayExit.promise, { staleMs: 300 });
      await waitFor(() => exists(lock));

      await writeFile(lock, "999999:owned-by-someone-else\n");
      await backdate(lock, 5_000);
      const before = await mtimeOf(lock);
      await sleep(300);
      expect(await mtimeOf(lock)).toBe(before);

      mayExit.resolve();
      await stalled;
      // And on the way out it must leave the stranger's lock alone, too.
      expect(await exists(lock)).toBe(true);
    });
  });
});
