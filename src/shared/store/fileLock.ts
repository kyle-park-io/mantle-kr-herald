import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";
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
 */
export const LOCK_STALE_MS = 30_000;

/**
 * How long to wait for the lock before giving up and throwing.
 *
 * This must be comfortably LONGER than {@link LOCK_STALE_MS}, and that ordering is the whole point
 * of the number: a waiter that arrives one millisecond after the holder crashes has to outlive the
 * staleness window before it is allowed to reclaim, so any timeout at or below `LOCK_STALE_MS`
 * would give up while the dead holder's lock still looked fresh — turning a recoverable crash into
 * a permanently failing command. 45s leaves a 15s margin past the reclaim point, which is far more
 * than the milliseconds a reclaim-then-acquire actually costs, and also swallows a long queue of
 * legitimate waiters (a ~10ms critical section clears hundreds of them per second).
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
 * - **From below.** The interval must be small enough that beats can be *missed*. Node timers fire
 *   late, never early, and a beat is two filesystem syscalls that can be delayed by the same loaded
 *   disk that made the critical section slow in the first place. At 6, five consecutive beats can be
 *   lost — 25 of the 30 seconds — before a live holder's lock even begins to look stale. One flaky
 *   beat causing a reclaim would be worse than no heartbeat at all, because it would look like the
 *   bug is fixed.
 * - **From above.** The interval must be large enough that the common case pays nothing. A real
 *   critical section is ~10ms, so at 5s the timer is cleared before it ever fires on roughly 499 of
 *   every 500 holds: zero extra syscalls on the fast path. The heartbeat exists for the pathological
 *   hold, and only that hold should pay for it.
 *
 * Anything from ~4 to ~10 would satisfy both; nothing here is sensitive to the exact value, which is
 * why it is a small integer and not a tuned constant.
 */
const HEARTBEAT_BEATS_PER_STALE_WINDOW = 6;

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
 * disk. Skipping a tick is free: the ratio above budgets for five missed beats in a row.
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
 * Removes the lock if its owner has plainly died, reporting whether the path is now free to retry.
 *
 * A live holder no longer reaches this branch. `withFileLock` refreshes its own lock's mtime on a
 * heartbeat for as long as `fn()` runs, so "untouched for `staleMs`" no longer means "held for a
 * while" — it means the owner's event loop has not run for `staleMs`: dead, killed, or frozen by
 * SIGSTOP, a debugger breakpoint or a machine suspend. A slow critical section, which used to be
 * indistinguishable from a corpse, now is distinguishable. Note the honest edge: a frozen process
 * cannot beat either, so it still looks stale — but a frozen process is also making no progress, so
 * treating it as dead is the intended outcome rather than a misreading, and `releaseIfOwned` stops
 * it from deleting its successor's lock when it thaws.
 *
 * **The race in the two syscalls below is narrowed, not closed.** Between the `stat` that judges the
 * lock stale and the `unlink` that removes it, the dead owner's file can be replaced by a live one:
 * another waiter reclaims first and a third process legitimately acquires, and then this `unlink`
 * deletes that third process's lock, leaving two holders running at once. What changed is only the
 * precondition. It used to be "a holder took longer than `staleMs`", which any suspended laptop or
 * debugger pause produced routinely; it is now "the owner's event loop is genuinely not running"
 * *and* two waiters race the same reclaim *and* a third acquires inside the gap. Rare enough to be a
 * different risk, not rare enough to call it fixed.
 *
 * `rename`-to-scratch was tried here and does not help — a rename is conditional on the path being
 * *occupied*, not on *which* file occupies it, so it succeeds against the replacement exactly as
 * `unlink` does, and the loser only gets ENOENT in the interleaving that was already harmless.
 *
 * What is left needs a shape this module does not have: an atomic compare-and-delete, which POSIX
 * does not offer, or the kernel owning the lock's lifetime (advisory `flock(2)`, released
 * automatically on process death, so nothing is reclaimed by hand at all). That remains filed rather
 * than smuggled in here.
 *
 * A missing file is success, not an error — someone else got there first.
 */
async function reclaimIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  let heldForMs: number;
  try {
    heldForMs = Date.now() - (await stat(lockPath)).mtimeMs;
  } catch (err: unknown) {
    // Already gone: the next acquisition attempt will find it free.
    if (isErrnoException(err) && err.code === "ENOENT") return true;
    throw err;
  }
  if (heldForMs <= staleMs) return false;
  await unlink(lockPath).catch(ignoreMissing);
  return true;
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

  const deadline = Date.now() + timeoutMs;
  let token: string | null = null;
  while (token === null) {
    token = await acquire(lockPath);
    if (token !== null) break;
    if (Date.now() >= deadline) {
      // `timeoutMs` at or below `staleMs` is a real misconfiguration — it means this call can never
      // outlive the staleness window, so it can never reclaim a lock whose owner died, and every
      // run fails identically until someone deletes the file by hand. Saying so here is what keeps
      // that silent: a deliberately short fail-fast timeout is legitimate, so this diagnoses rather
      // than rejects it.
      const misconfigured =
        timeoutMs <= staleMs
          ? ` This timeout is not longer than the ${staleMs}ms staleness window, so a lock left by a dead ` +
            `process can never be reclaimed by this call — raise timeoutMs above staleMs.`
          : "";
      throw new Error(
        `Timed out after ${timeoutMs}ms acquiring the lock on ${path} (${await holderDescription(lockPath)}). ` +
          `Refusing to write unprotected: a concurrent read-modify-write would drop a row, and a dropped ` +
          `send row becomes a duplicate live post. If no such process is running, remove ${lockPath}.${misconfigured}`,
      );
    }
    // A lock we just reclaimed is free right now, so retry at once; otherwise wait for the holder.
    if (!(await reclaimIfStale(lockPath, staleMs))) await sleep(RETRY_INTERVAL_MS);
  }

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
    // is synchronous, so it still happens if `releaseIfOwned` itself fails.
    stopHeartbeat();
    // ...but only release if the lock is still ours. See `releaseIfOwned`.
    await releaseIfOwned(lockPath, token);
  }
}
