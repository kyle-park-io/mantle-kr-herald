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

/** `wx` is `O_CREAT | O_EXCL`: the kernel decides the winner, so exactly one caller can succeed. */
async function acquire(lockPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EEXIST") return false;
    throw err;
  }
  try {
    // The owning pid costs nothing to record and turns "why is this stuck" into a one-line answer.
    await handle.writeFile(`${process.pid}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Removes the lock if its owner has plainly died, reporting whether it did. Reclaiming is itself
 * racy — another waiter may reclaim the same lock, or the owner may release it, between the `stat`
 * and the `unlink` — so a missing file is a success, not an error.
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

async function holderDescription(lockPath: string): Promise<string> {
  const pid = await readFile(lockPath, "utf8").then((t) => t.trim(), () => "");
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
  for (;;) {
    if (await acquire(lockPath)) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms acquiring the lock on ${path} (${await holderDescription(lockPath)}). ` +
          `Refusing to write unprotected: a concurrent read-modify-write would drop a row, and a dropped ` +
          `send row becomes a duplicate live post. If no such process is running, remove ${lockPath}.`,
      );
    }
    // A lock we just reclaimed is free right now, so retry at once; otherwise wait for the holder.
    if (!(await reclaimIfStale(lockPath, staleMs))) await sleep(RETRY_INTERVAL_MS);
  }

  try {
    return await fn();
  } finally {
    // Release even when the job threw, or one failed write would wedge every later one until the
    // staleness window expires. The file may already be gone if a waiter judged us stale.
    await unlink(lockPath).catch(ignoreMissing);
  }
}
