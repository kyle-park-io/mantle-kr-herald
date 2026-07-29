import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_STALE_MS } from "../shared/store/fileLock";
import { isErrnoException } from "../shared/store/jsonFile";
import { isLockFile, isStrandedTempFile } from "./retention";

/**
 * `stat`, treating a path that vanished between the `readdir` and the `stat` as gone rather than
 * as an error. A sweep walks a live tree: lock files are the most transient thing in it — created
 * and deleted on *every* ledger write — so a send releasing its lock mid-walk is the normal case,
 * not an exceptional one. Letting that `ENOENT` propagate would abort the whole command precisely
 * when a send is running, which is the situation the staleness gate below exists to survive.
 */
async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Collects debris an interrupted write can leave next to a live store: the temp file of a killed
 * atomic write, and the lock file of a process that died mid-write. Live stores are never matched —
 * see `isStrandedTempFile`.
 *
 * Walks `dir` recursively, skipping `skipDir` (the archive, which has its own retention rule).
 * Returns absolute paths; deciding what to do with them is the caller's job, so this stays safe to
 * call and easy to test.
 */
export async function collectWriteDebris(dir: string, opts: { skipDir?: string } = {}): Promise<string[]> {
  const targets: string[] = [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return targets;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (isStrandedTempFile(name)) {
      if (isLockFile(name)) {
        const held = await statIfPresent(full);
        // Already released while we walked — nothing to clean, and nothing to complain about.
        if (!held) continue;
        // A lock younger than the staleness window may still belong to a running send. Removing it
        // would let a second process interleave a read-modify-write of the same ledger and drop a
        // row — and a dropped send row is a duplicate live post. Leave those to their owner.
        if (Date.now() - held.mtimeMs < LOCK_STALE_MS) continue;
      }
      targets.push(full);
      continue;
    }
    const entry = await statIfPresent(full);
    if (entry?.isDirectory() && full !== opts.skipDir) {
      targets.push(...(await collectWriteDebris(full, opts)));
    }
  }
  return targets;
}
