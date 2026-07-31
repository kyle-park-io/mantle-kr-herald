import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "../shared/store/jsonFile";
import { isStrandedTempFile } from "./retention";

/**
 * How old a piece of write debris must be before `pnpm clean` may remove it.
 *
 * The only thing this is guarding against is a genuinely in-progress `writeJsonFileAtomic` call —
 * its own `writeFile` then `rename` is single-digit milliseconds on any disk this tool runs on, so
 * 30s is pure headroom against a loaded disk or CI box, not a guess about how long a write might
 * legitimately take. Taking a `.tmp-*` file mid-rename turns a completed send into a ledger write
 * `SendChannels` reports as "was SENT but could NOT be recorded in the ledger — a rerun will
 * re-send it" (`src/app/SendChannels.ts`) — a duplicate live post caused by the cleanup command
 * itself, which is why the margin errs generous rather than tight.
 */
export const IN_PROGRESS_MS = 30_000;

/**
 * `stat`, treating a path that vanished between the `readdir` and the `stat` as gone rather than
 * as an error. A sweep walks a live tree: a send releasing its lock mid-walk used to be the normal
 * case, and a `.tmp-*` being renamed away mid-walk still is — letting that `ENOENT` propagate would
 * abort the whole command precisely when a send is running.
 */
async function statIfPresent(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

async function walk(dir: string, skipDir: string | undefined, now: number, found: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (isStrandedTempFile(name)) {
      const debris = await statIfPresent(full);
      // Already gone while we walked — nothing to clean, and nothing to complain about.
      if (!debris) continue;
      // Young enough that a live `writeJsonFileAtomic` call may still be using it — see `IN_PROGRESS_MS`.
      if (now - debris.mtimeMs < IN_PROGRESS_MS) continue;
      found.push(full);
      continue;
    }
    const entry = await statIfPresent(full);
    if (entry?.isDirectory() && full !== skipDir) {
      await walk(full, skipDir, now, found);
    }
  }
}

/**
 * Collects debris an interrupted write can leave next to a live store: the temp file of a killed
 * atomic write, plus a stray lock file from a build old enough to have written one (nothing does
 * any more — see `isStrandedTempFile`). Live stores are never matched.
 *
 * Walks `dir` recursively, skipping `skipDir` (the archive, which has its own retention rule).
 * Returns absolute paths; deciding what to do with them is the caller's job, so this stays safe to
 * call and easy to test.
 */
export async function collectWriteDebris(dir: string, opts: { skipDir?: string } = {}): Promise<string[]> {
  const found: string[] = [];
  await walk(dir, opts.skipDir, Date.now(), found);
  return found;
}
