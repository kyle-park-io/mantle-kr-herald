import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { isErrnoException } from "./jsonFile";

/**
 * How long a lock file may sit untouched before the next process presumes its owner died and
 * reclaims it.
 *
 * "Untouched" is load-bearing, and it means more than it used to: a holder refreshes its own lock's
 * mtime on a heartbeat for as long as its job runs (see {@link HEARTBEAT_BEATS_PER_STALE_WINDOW}),
 * so this window is no longer a guess about how long a critical section might take. It is the answer
 * to "how long may the owner's event loop fail to run before we call it dead".
 *
 * The critical section a lock guards is one local read-modify-write of a small JSON ledger — read,
 * mutate a Map in memory, write a temp file, rename. That is single-digit milliseconds on any disk
 * this tool runs on; nothing inside a lock waits on the network. 30s is therefore ~3 orders of
 * magnitude of headroom, which absorbs a loaded CI box or a long GC pause without ever stealing a
 * lock from a holder that is merely slow. It is also short enough that a genuinely crashed
 * `pnpm send:channels` does not wedge the dashboard until someone notices: the next write reclaims
 * within half a minute.
 *
 * **A suspend longer than this window is still an open hazard, and the heartbeat does not close it.**
 * A process frozen by SIGSTOP, a debugger breakpoint or a machine suspend cannot beat — nothing in it
 * runs at all — so it looks exactly like a corpse and gets reclaimed. It is not a corpse: it thaws,
 * finishes its read-modify-write, and now two processes are writing one ledger. The ownership token
 * stops the thawed holder *deleting* its successor's lock (see `releaseIfOwned`); nothing stops it
 * *writing*. What this 30s buys is that suspends shorter than it are absorbed rather than misread.
 * Beyond it the old hazard is unchanged, and the only real fix is kernel-owned lock lifetime
 * (`flock(2)`), where a frozen process still holds its lock because the kernel holds it for them.
 */
export const LOCK_STALE_MS = 30_000;

/**
 * How long to wait for the lock before giving up and throwing.
 *
 * This must be comfortably LONGER than {@link LOCK_STALE_MS} plus {@link RECLAIM_CONFIRM_MS}, and
 * that ordering is the whole point of the number: a waiter that arrives one millisecond after the
 * holder crashes has to outlive the staleness window *and* then watch the lock stay stale for the
 * confirmation window before it is allowed to reclaim, so any timeout at or below their sum would
 * give up before it could ever act — turning a recoverable crash into a permanently failing command.
 * 45s leaves a 14s margin past the 31s reclaim point, which is far more than the milliseconds a
 * reclaim-then-acquire actually costs, and also swallows a long queue of legitimate waiters (a ~10ms
 * critical section clears hundreds of them per second).
 */
export const LOCK_TIMEOUT_MS = 45_000;

/**
 * How long to sleep between acquisition attempts. Polling adds at most this much latency on top of
 * the holder's critical section, so it wants to be small relative to that ~10ms section, while
 * staying large enough that a long wait does not spin the disk with thousands of `open` syscalls.
 */
const RETRY_INTERVAL_MS = 25;

/**
 * How many heartbeats are meant to fit inside one staleness window.
 *
 * This is expressed as a ratio, not a duration, because `staleMs` is per call: the ledgers use the
 * 30s default (so a beat every 5s) while tests drive the same code with `staleMs` in the hundreds of
 * milliseconds, and a hardcoded interval would silently stop protecting the second case.
 *
 * 6 is chosen from both ends:
 *
 * - **From below.** The interval must be small enough that a beat can be late without a live holder
 *   being mistaken for a dead one. Node timers fire late, never early, and a beat is two filesystem
 *   syscalls that can be delayed by the same loaded disk that made the critical section slow in the
 *   first place. A reclaim caused by one late beat would be worse than no heartbeat at all, because
 *   it would look like the bug is fixed.
 *
 *   **How much lateness that actually buys depends entirely on whether the wall clock is sane, and
 *   the two numbers are far apart.** On a machine whose clock only moves forward at one second per
 *   second, a lock is judged by `Date.now() - mtime` and the budget is the whole window minus one
 *   interval: 25s, i.e. five consecutive beats may be lost. On the machine this was developed on the
 *   budget is **2292ms — 0.46 of a single interval**, and no beat may be missed at all. That machine
 *   steps `CLOCK_REALTIME` back and forth by ~22.71s in a 5.00s square wave (~0.26s high, ~4.74s
 *   low, `dMono ≈ 0` across every edge), because WSL2's Hyper-V host time sync and an active
 *   `systemd-timesyncd` are both stepping it while `timedatectl` reports the clock unsynchronised.
 *   A forward step adds its whole size to every lock's apparent age until the next beat re-stamps
 *   it, so the live holder's worst apparent age is one interval plus one step:
 *
 *   | divisor | interval | + step | vs 30s window |
 *   | ---     | ---      | ---    | ---           |
 *   | 4       | 7.5s     | 30.2s  | reclaims a working process |
 *   | **6**   | **5s**   | 27.7s  | inside, by 2.29s |
 *   | 10      | 3s       | 25.7s  | inside, by 4.29s |
 *
 *   That is a local misconfiguration, not a property of dev laptops in general, and the honest
 *   reading is not "6 guarantees five missed beats" — it does not — but "6 was the smallest divisor
 *   that still held up under an observed pathological clock, and 4 was not". The margin that
 *   survives *both* cases is the 2292ms one. Size any change to this number against that, not
 *   against the 25s.
 *
 *   The dependence on that amplitude staying at 22.71s is deliberately not the only thing standing
 *   between a live holder and a reclaim, and neither is this divisor. {@link RECLAIM_CONFIRM_MS}
 *   outlasts a step of *any* size (it depends on how long the excursion lasts, not how big it is),
 *   and `createReclaimer` additionally resets its window whenever the mtime MOVES — a beat landing
 *   at all is proof of life that needs no clock to read, whatever the apparent age says.
 * - **From above.** The interval must be large enough that the common case pays nothing. A real
 *   critical section is ~10ms, so at 5s the timer is cleared before it ever fires on roughly 499 of
 *   every 500 holds: zero extra syscalls on the fast path (measured: 200 holds, 0 callbacks, 0 mtime
 *   writes). The heartbeat exists for the pathological hold, and only that hold should pay for it.
 *
 * That leaves roughly 6–10 usable, and 6 is taken from the low end because the costs are asymmetric:
 * beating too often wastes two syscalls nobody will notice, beating too rarely hands a live holder's
 * ledger to a second writer.
 */
const HEARTBEAT_BEATS_PER_STALE_WINDOW = 6;

/**
 * How long a lock must look stale *without interruption* before it may be reclaimed.
 *
 * The heartbeat makes "stale" mean "the owner's event loop has not run". This makes it mean "…and
 * still has not, a second later", which is a different and more robust claim, because it separates
 * the two ways a lock's apparent age can exceed the window:
 *
 * - **A dead owner is stale forever.** Its mtime never moves again, so every observation from here
 *   to the heat death of the disk agrees.
 * - **A stepped clock is stale for a moment.** Apparent age is `Date.now() - mtime`, so a forward
 *   step of the wall clock inflates *every* lock's age by its own size — including one a live holder
 *   stamped milliseconds ago. But a step is transient by construction: it ends when the clock is
 *   corrected, or when the next beat re-stamps the mtime under the new clock.
 *
 * Requiring persistence tells those apart without knowing anything about the step's size, which is
 * the entire point of preferring it to the alternative of simply widening {@link LOCK_STALE_MS}.
 * Widening trades away crash recovery — a dead `pnpm send:channels` would wedge the dashboard for
 * proportionally longer — and it stays a bet on the amplitude, which a misconfigured clock has no
 * obligation to keep at any particular value. This does not care how large the step is, only that it
 * ends.
 *
 * **Measured in monotonic time, necessarily.** `performance.now()` does not follow `CLOCK_REALTIME`,
 * so it cannot be stepped by the thing this exists to survive. Timing the confirmation window with
 * `Date.now()` would let a single step satisfy the window it was supposed to disqualify.
 *
 * 1s is chosen against the observed excursion, not against a poll count. The developed-on machine
 * holds its stepped state for ~0.26s at a time, so 1s is ~4x that; and expressing it as a duration
 * rather than "N consecutive observations" is what keeps it meaningful, since N polls at
 * {@link RETRY_INTERVAL_MS} would be 3 x 25ms = 75ms — comfortably *inside* a 260ms excursion, and
 * therefore no protection at all. The cost is 1s added to a genuine reclaim, once, against a 45s
 * timeout; and nothing whatsoever when the lock is simply held.
 *
 * **Sized against the excursion's DURATION, not its amplitude.** That is the right dependency to
 * have — a step's size is arbitrary while a mitigation that outlasts the step needs only to be
 * longer than it lasts — but it is a dependency, so it is stated: invert the observed wave to 4.75s
 * high and 0.26s low and one second would confirm straight through it. The measurement it is sized
 * against (~0.26s high, 5.3% duty cycle over 4884 samples) is on `LOCK_STALE_MS`.
 *
 * Exported for `src/storage/sweep.ts`, which judges the same lock files by the same predicate and
 * must not be more permissive than this module: `pnpm clean` deleting a lock the reclaimer here
 * still refuses to touch is the same two-writer bug arriving through the cleanup command.
 */
export const RECLAIM_CONFIRM_MS = 1_000;

/** The lock guarding `path`. Each file gets its own — never one shared lock, which would serialize unrelated ledgers. */
export function lockPathFor(path: string): string {
  return `${path}.lock`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ignoreMissing = (err: unknown): void => {
  if (isErrnoException(err) && err.code === "ENOENT") return;
  throw err;
};

/**
 * Takes the lock and returns the token identifying *this* acquisition, or null if someone holds it.
 *
 * `wx` is `O_CREAT | O_EXCL`: the kernel decides the winner, so exactly one caller can succeed.
 *
 * The token is `<pid>:<uuid>`. The pid alone would not do: pids are recycled, and one process
 * acquires the same lock over and over, so "written by pid 4821" cannot distinguish the lock we are
 * holding now from a later one taken by the same process after ours was reclaimed. Everything that
 * deletes a lock compares this token first, which is what stops a holder from deleting its
 * successor's lock. The pid stays in it because it is what an operator needs to see.
 */
async function acquire(lockPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EEXIST") return null;
    throw err;
  }
  const token = `${process.pid}:${randomUUID()}`;
  try {
    await handle.writeFile(`${token}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return token;
}

/**
 * Stamps the lock's mtime forward, but only while the token in it is still ours.
 *
 * Returns false once the lock is demonstrably no longer ours, which is a terminal answer: tokens are
 * unique per acquisition, so a lock that stopped matching can never start matching again.
 *
 * The ownership check is not politeness. Without it the sequence "A freezes → A's lock is reclaimed
 * → B acquires → B dies → A thaws" would have A's timer indefinitely refreshing *B's* corpse of a
 * lock, so nothing would ever look stale and the ledger would stay wedged until someone deleted the
 * file by hand — a heartbeat inventing the exact deadlock it was added to prevent.
 *
 * `utimes` rather than rewriting the file, for two reasons beyond cost. It cannot create a path that
 * is not there, so a beat that loses the race against our own release gets a clean ENOENT instead of
 * resurrecting a released lock and wedging the ledger for a full staleness window. And it never
 * makes the contents momentarily unreadable, which a truncating write would — `releaseIfOwned` and
 * `holderDescription` read this file by path and would see an empty token.
 *
 * **No test pins that choice, and one cannot be written from outside this module.** Swapping `utimes`
 * for a `writeFile` of the same token leaves the whole suite green, because the `readFile` above
 * already turns the ordinary "released while we beat" case into an ENOENT before the stamp is
 * reached. The interleaving the choice actually protects against needs the release to land *between*
 * that read and the stamp, which no caller can arrange. So it is written down here instead: the
 * failure it prevents is a lock file holding a dead process's token that nothing will ever release,
 * i.e. every later ledger write waiting out the full reclaim (31s) — recoverable, but a self-inflicted
 * stall on every send, and invisible in review if this is ever "simplified".
 *
 * A race survives *inside* this function — the lock can change owner between the read and the
 * `utimes`, so we can bump a stranger's lock by one beat. That one is harmless in a way the module's
 * other races are not, and the asymmetry is the point: this can only make a lock look *fresher*, and
 * freshness never produces two concurrent holders. Only staleness does.
 */
async function touchIfOwned(lockPath: string, token: string): Promise<boolean> {
  if ((await readFile(lockPath, "utf8")).trim() !== token) return false;
  const now = new Date();
  await utimes(lockPath, now, now);
  return true;
}

/**
 * Keeps proving the lock's owner is alive until the returned function is called.
 *
 * This is what turns `reclaimIfStale`'s judgement from a guess into an observation. Without it the
 * mtime is stamped once at acquisition and never refreshed, so "held for longer than `staleMs`" and
 * "the owner died" are the same reading, and a merely slow critical section gets its lock taken from
 * underneath it.
 *
 * Three properties this must have, all of which are easy to lose:
 *
 * 1. **The timer must not keep the process alive.** Every caller here is a short-lived CLI —
 *    `pnpm send:channels` and friends — that has to exit when its work is done. A ref'd interval
 *    outlives any hold that never releases (an abandoned promise, a job awaiting something that
 *    never settles) and hangs the command forever with no output. `unref` makes the worst case
 *    "the process exits and leaves a lock behind", which is the ordinary crash path this module
 *    already recovers from within `staleMs`.
 * 2. **A failing beat must not touch the job it protects.** Throwing out of a timer callback is an
 *    unhandled rejection, i.e. killing the process in the middle of the read-modify-write whose
 *    interruption is the whole hazard; aborting `fn()` would do the same thing deliberately. So a
 *    beat that fails for any non-terminal reason is swallowed and retried on the next tick — often
 *    it is transient (EIO, ENOSPC, a full disk being cleared), and if every beat fails the lock
 *    simply looks stale again, which is exactly the behaviour before this existed. Strictly no
 *    worse, frequently better, never fatal.
 * 3. **Only the lock we still own may be refreshed** — see `touchIfOwned`. Losing it is terminal, so
 *    the timer stops rather than beating pointlessly for the rest of a long job.
 *
 * The in-flight guard keeps a slow beat from stacking further beats behind it on an already-loaded
 * disk. Skipping a tick is *not* free — see {@link HEARTBEAT_BEATS_PER_STALE_WINDOW} for how thin
 * that budget gets under a stepping clock — but stacking beats on a disk that is already too slow to
 * finish one would be worse, and {@link RECLAIM_CONFIRM_MS} is what covers the gap either way.
 */
function startHeartbeat(lockPath: string, token: string, intervalMs: number): () => void {
  let beating = false;
  const timer = setInterval(() => {
    if (beating) return;
    beating = true;
    void touchIfOwned(lockPath, token)
      .then(
        (stillOurs) => {
          if (!stillOurs) clearInterval(timer);
        },
        (err: unknown) => {
          // Gone entirely: as terminal as a token mismatch, and reached by the same routes.
          if (isErrnoException(err) && err.code === "ENOENT") clearInterval(timer);
          // Anything else: swallowed on purpose. See (2) above.
        },
      )
      .finally(() => {
        beating = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Builds one acquisition loop's reclaimer: removes the lock once its owner has plainly died, and
 * reports whether the path is free to retry immediately.
 *
 * It is a factory because the verdict is no longer a function of a single observation — it needs to
 * remember how long the lock has looked stale *without interruption* (see
 * {@link RECLAIM_CONFIRM_MS}). One reclaimer per `withFileLock` call; the run resets on a fresh
 * observation **or on an mtime that moved**, so a lock has to be consistently dead, not momentarily
 * unlucky, and a window earned against one lock is never spent on another.
 *
 * **What "stale" now means, and what it still gets wrong.** `withFileLock` refreshes its own lock's
 * mtime on a heartbeat for as long as `fn()` runs, so an untouched lock no longer means "held for a
 * while" — it means the owner's event loop has not run: dead, killed, or *frozen* by SIGSTOP, a
 * debugger breakpoint or a machine suspend. The first two are corpses and reclaiming them is the
 * whole point. **The third is not, and this still gets it wrong.** A frozen holder thaws, finishes
 * its read-modify-write, and by then a second process has taken the lock and is writing the same
 * ledger — two live writers, whichever row loses the rename gone, and a duplicate live post. The
 * ownership token stops the thawed holder *deleting* its successor's lock; nothing stops it
 * *writing*. That hazard is exactly as open as it was before the heartbeat existed, and only
 * kernel-owned lock lifetime (`flock(2)`, where a frozen process keeps its lock because the kernel
 * holds it on their behalf) actually closes it. What the heartbeat removed is the *routine* case —
 * a holder that was merely slow — which used to be indistinguishable from all of the above.
 *
 * **The race in the two syscalls below is narrowed, not closed.** Between the `stat` that judges the
 * lock stale and the `unlink` that removes it, the dead owner's file can be replaced by a live one:
 * another waiter reclaims first and a third process legitimately acquires, and then this `unlink`
 * deletes that third process's lock, leaving two holders running at once. What changed is only the
 * precondition. It used to be "a holder took longer than `staleMs`", which any slow disk produced
 * routinely; it is now "the owner's event loop has not run for `staleMs` *and* has still not run a
 * second later" *and* two waiters race the same reclaim *and* a third acquires inside the gap. Rare
 * enough to be a different risk, not rare enough to call it fixed.
 *
 * `rename`-to-scratch was tried here and does not help — a rename is conditional on the path being
 * *occupied*, not on *which* file occupies it, so it succeeds against the replacement exactly as
 * `unlink` does, and the loser only gets ENOENT in the interleaving that was already harmless.
 *
 * What is left needs a shape this module does not have: an atomic compare-and-delete, which POSIX
 * does not offer, or `flock(2)` above. That remains filed rather than smuggled in here.
 *
 * A missing file is success, not an error — someone else got there first.
 */
function createReclaimer(lockPath: string, staleMs: number): () => Promise<boolean> {
  /**
   * The confirmation run in progress: when it started (monotonic, so the window cannot be satisfied
   * by the same clock step it exists to outlast) and **the exact mtime it is watching**. Null means
   * the last look said fresh.
   *
   * The two travel together deliberately — the run is anchored to a fact about the file, not to a
   * clock reading.
   *
   * Without it, `staleSince` says only *when staleness started* — not which lock was stale — so a
   * window opened against a dead lock could be spent unlinking whatever occupied the path when it
   * elapsed. Reachable in three steps: this waiter starts confirming a corpse, another waiter
   * reclaims it and a third process legitimately acquires, and this waiter's next look reads the new
   * holder's lock as stale (a clock step, or a beat that has not landed yet). The window is already
   * satisfied, so the live holder's lock is unlinked and a fourth process walks in — two holders, the
   * exact outcome the confirmation window was added to prevent. Reproduced: a successor observed
   * stale for 64ms was unlinked by a run that advertises 1000ms.
   *
   * Keying the run on the mtime makes a *different* lock start its own window, and makes a MOVED
   * mtime — a beat — reset the run even while apparent age still exceeds `staleMs`. That second half
   * matters as much as the first: on a stepped clock a live holder's lock can read old on every
   * single look, and a moving mtime is the holder's own proof of life, true without reference to any
   * clock.
   */
  let run: { since: number; mtimeMs: number } | null = null;

  return async function reclaimIfStale(): Promise<boolean> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch (err: unknown) {
      // Already gone: the next acquisition attempt will find it free.
      if (isErrnoException(err) && err.code === "ENOENT") return true;
      throw err;
    }
    if (Date.now() - mtimeMs <= staleMs) {
      // One sight of a living holder discards the whole run. A dead owner will never do this.
      run = null;
      return false;
    }
    if (run === null || run.mtimeMs !== mtimeMs) {
      // A lock we have not been watching — a successor, or the same one that just beat. Either way
      // this is look one of ITS window, not the last look of somebody else's.
      run = { since: performance.now(), mtimeMs };
    }
    // Still inside the confirmation window: report "held" so the caller waits and looks again.
    if (performance.now() - run.since < RECLAIM_CONFIRM_MS) return false;
    await unlink(lockPath).catch(ignoreMissing);
    run = null;
    return true;
  };
}

/**
 * Deletes the lock only if it is still the one we took.
 *
 * A holder stalled past `staleMs` — a suspended laptop, a debugger, a severe I/O stall — has its
 * lock reclaimed underneath it and a new holder takes the path. An unconditional `unlink` here
 * would then delete *that* holder's lock and leave the ledger disarmed for the rest of its critical
 * section, letting arbitrarily many callers walk in on a plain acquire. That is the duplicate live
 * post this whole module exists to prevent, so the token is checked first and a mismatch means:
 * not ours, leave it alone.
 *
 * The read is by path, deliberately. Reading through the file handle we opened at acquisition would
 * be cheaper but wrong — after a reclaim that handle refers to the unlinked inode and still holds
 * our own token, so it would report "still ours" precisely when it is not. Comparing inode numbers
 * instead would be cheaper again and also wrong: ext4 recycles inode numbers.
 *
 * A window remains, narrowed from "the entire critical section" to the gap between this read and
 * this unlink: a reclaimer must remove our lock and a third process acquire, both inside those two
 * syscalls. It used to be easy to reach. The mtime was stamped once at acquisition and never
 * refreshed, so a long critical section left the lock already stale well before control got here —
 * and this read runs at the very end of that section, which was exactly when staleness was most
 * likely. The heartbeat removes that setup: a holder whose event loop runs keeps its own lock fresh
 * right up to this call, so the lock we are about to release is stale only if we were frozen long
 * enough to be reclaimed and have since thawed. Closing the remainder needs an atomic
 * compare-and-delete, which POSIX does not offer, or one of the designs noted on `reclaimIfStale`.
 */
async function releaseIfOwned(lockPath: string, token: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, "utf8");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return;
    throw err;
  }
  if (current.trim() !== token) return;
  await unlink(lockPath).catch(ignoreMissing);
}

async function holderDescription(lockPath: string): Promise<string> {
  const token = await readFile(lockPath, "utf8").then((t) => t.trim(), () => "");
  const pid = token.split(":")[0];
  return pid ? `held by pid ${pid}` : "holder unknown";
}

/**
 * Runs `fn` while holding an exclusive, cross-process lock on `path`.
 *
 * `createSerializer` orders writes inside one process; this orders them between processes. Both are
 * needed because the ledgers under `output/publish/` are read-modify-write: a `pnpm send:channels`
 * run while the dashboard `pnpm serve` is up has two serializers over one file, both read the same
 * array, and the second rename discards the first one's row. That dropped row is not cosmetic — the
 * ledger is what stops a re-send, so a row that vanishes becomes a duplicate live post to a brand's
 * community room or X account.
 *
 * On acquisition timeout this **throws** rather than proceeding unprotected. Running the job anyway
 * would convert a delay — which the caller can retry — into a lost row, which nobody can undo.
 *
 * Every acquisition carries an ownership token, and nothing deletes or refreshes a lock it does not
 * own. That matters because a stalled holder's lock gets reclaimed underneath it: without the check,
 * that holder's release would delete its successor's lock and disarm the ledger mid-write.
 *
 * While `fn` runs, a heartbeat keeps stamping our lock's mtime forward, so a holder that is merely
 * slow never looks like a holder that died. See `startHeartbeat` for why the timer is `unref`'d and
 * why a failed beat is swallowed rather than raised.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: { staleMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const lockPath = lockPathFor(path);
  // The ledger's directory may not exist on a first run — the atomic write creates it, but that
  // happens inside the lock, so without this the very first send would fail on ENOENT.
  await mkdir(dirname(lockPath), { recursive: true });

  // Monotonic. `Date.now()` would make the deadline steppable by the same clock that inflates lock
  // ages, and in the same direction: one forward step and a waiter gives up ~22.8s early against a
  // holder it would otherwise have outlasted, without ever reaching the reclaim below. mtime cannot
  // be monotonic — the filesystem stamps it in wall-clock time — but the timeout trivially can.
  const startedAt = performance.now();
  const reclaimIfStale = createReclaimer(lockPath, staleMs);
  let token: string | null = null;
  while (token === null) {
    token = await acquire(lockPath);
    if (token !== null) break;
    if (performance.now() - startedAt >= timeoutMs) {
      // A `timeoutMs` that cannot outlive `staleMs` *plus* the confirmation window is a real
      // misconfiguration — it means this call can never reclaim a lock whose owner died, and every
      // run fails identically until someone deletes the file by hand. Saying so here is what keeps
      // that from being silent: a deliberately short fail-fast timeout is legitimate, so this
      // diagnoses rather than rejects it.
      const reclaimableAfterMs = staleMs + RECLAIM_CONFIRM_MS;
      const misconfigured =
        timeoutMs <= reclaimableAfterMs
          ? ` This timeout is not longer than the ${reclaimableAfterMs}ms a reclaim needs (${staleMs}ms staleness ` +
            `window plus ${RECLAIM_CONFIRM_MS}ms confirming it), so a lock left by a dead process can never be ` +
            `reclaimed by this call — raise timeoutMs above ${reclaimableAfterMs}ms.`
          : "";
      throw new Error(
        `Timed out after ${timeoutMs}ms acquiring the lock on ${path} (${await holderDescription(lockPath)}). ` +
          `Refusing to write unprotected: a concurrent read-modify-write would drop a row, and a dropped ` +
          `send row becomes a duplicate live post. If no such process is running, remove ${lockPath}.${misconfigured}`,
      );
    }
    // A lock we just reclaimed is free right now, so retry at once; otherwise wait for the holder.
    // The sleep is also the confirmation window's sampling interval — see `createReclaimer`.
    if (!(await reclaimIfStale())) await sleep(RETRY_INTERVAL_MS);
  }

  // The beat rate is derived from *this* caller's `staleMs`, while the verdict on whether the lock
  // looks stale is rendered by a *different* caller using its own. They are the same number today
  // because no production caller passes `staleMs` at all (checked: `JsonDeliveryLedger` and
  // `JsonXArticleLedger` are the only two, and neither overrides it), and the tests that do pass it
  // pass it to both sides. Give one process a window narrower than another's beat interval and it
  // will reclaim a live, beating holder — so if `staleMs` ever becomes a per-caller policy, the beat
  // rate has to be derived from the smallest window in the system rather than from the holder's own.
  const stopHeartbeat = startHeartbeat(
    lockPath,
    token,
    Math.max(1, Math.floor(staleMs / HEARTBEAT_BEATS_PER_STALE_WINDOW)),
  );
  try {
    return await fn();
  } finally {
    // Both of these run on every exit path, including a throwing job. Skipping the release would
    // wedge every later write until the staleness window expired; skipping the heartbeat teardown
    // would leave a timer beating against a lock we are about to delete. The teardown goes first and
    // is synchronous, so it still happens if the release fails.
    stopHeartbeat();
    // ...and only release if the lock is still ours. See `releaseIfOwned`.
    //
    // A failing release must never change the job's outcome, which is why this is caught rather than
    // awaited bare. A `throw` from a `finally` replaces whatever the `try` produced: a *completed*
    // ledger write would be reported to `SendChannels` as a failure, and a send that is reported
    // failed gets retried — which is the duplicate live post this entire module exists to prevent,
    // caused by the cleanup rather than by the work. It would equally bury a real error thrown by
    // `fn` under an unrelated EACCES.
    //
    // Swallowing is safe in a way that is worth stating: everything a failed release can leave
    // behind is a lock file, and a lock file with no live owner is precisely what the staleness
    // window plus `RECLAIM_CONFIRM_MS` already reclaim. The cost is bounded and self-healing; the
    // cost of the alternative is not. It is still logged, because the ledger being briefly
    // unwritable is worth an operator's attention even though it resolves itself.
    await releaseIfOwned(lockPath, token).catch((err: unknown) => {
      console.warn(
        `[lock] could not release ${lockPath}: ${(err as Error).message} — the job's own outcome ` +
          `stands; the lock will be reclaimed as stale within ${staleMs + RECLAIM_CONFIRM_MS}ms`,
      );
    });
  }
}
