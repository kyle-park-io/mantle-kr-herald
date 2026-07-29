import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isErrnoException } from "./jsonFile";

/**
 * How long a lock file may sit untouched before the next process presumes its owner died and
 * reclaims it.
 *
 * The critical section a lock guards is one local read-modify-write of a small JSON ledger — read,
 * mutate a Map in memory, write a temp file, rename. That is single-digit milliseconds on any disk
 * this tool runs on; nothing inside a lock waits on the network. 30s is therefore ~3 orders of
 * magnitude of headroom, which absorbs a suspended laptop, a loaded CI box or a debugger pause
 * without ever stealing a lock from a holder that is merely slow. It is also short enough that a
 * genuinely crashed `pnpm send:channels` does not wedge the dashboard until someone notices: the
 * next write reclaims within half a minute.
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
 * Removes the lock if its owner has plainly died, reporting whether the path is now free to retry.
 *
 * **Reclaiming is racy and this does not fix that.** Between the `stat` that judges the lock stale
 * and the `unlink` that removes it, the dead owner's file can be replaced by a live one: another
 * waiter reclaims first and a third process legitimately acquires, and then this `unlink` deletes
 * that third process's lock, leaving two holders running at once. `rename`-to-scratch was tried
 * here and does not help — a rename is conditional on the path being *occupied*, not on *which*
 * file occupies it, so it succeeds against the replacement exactly as `unlink` does, and the loser
 * only gets ENOENT in the interleaving that was already harmless.
 *
 * Genuinely closing it needs a different shape: either the holder keeps proving it is alive (an
 * mtime heartbeat refreshed through the critical section, so "stale" stops being a guess) or the
 * kernel owns the lock's lifetime (advisory `flock(2)`, released automatically on process death, so
 * nothing has to be reclaimed by hand at all). Both are larger design changes than this module
 * carries today, and both are filed rather than smuggled in here.
 *
 * Reaching the window at all requires a holder stalled past `staleMs`. A missing file is success,
 * not an error — someone else got there first.
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
 * this unlink. Its precondition is not that the lock turns stale inside those two syscalls: the
 * mtime is stamped once at acquisition and never refreshed, so a long critical section can leave
 * the lock already stale well before we get here — and this read runs at the very end of that
 * section, which is exactly when staleness is most likely. What the window needs is for a reclaimer
 * to remove our stale lock and a third process to acquire, both between the read and the unlink.
 * Closing it completely needs an atomic compare-and-delete, which POSIX does not offer, or one of
 * the two designs noted on `reclaimIfStale`.
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
 * Every acquisition carries an ownership token, and nothing deletes a lock it does not own. That
 * matters because a stalled holder's lock gets reclaimed underneath it: without the check, that
 * holder's release would delete its successor's lock and disarm the ledger mid-write.
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

  try {
    return await fn();
  } finally {
    // Release even when the job threw, or one failed write would wedge every later one until the
    // staleness window expires — but only if the lock is still ours. See `releaseIfOwned`.
    await releaseIfOwned(lockPath, token);
  }
}
