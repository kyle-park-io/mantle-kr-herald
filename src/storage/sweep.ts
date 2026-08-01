import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isErrnoException } from "../shared/store/jsonFile";
import { isStrandedTempFile } from "./retention";

/**
 * How old a piece of write debris must be before `pnpm clean` may remove it.
 *
 * 31_000 — `30_000 + 1_000` — is not a rounder number picked fresh; it is the exact effective gate
 * the old file lock's age check plus its confirmation window (`LOCK_STALE_MS` + `RECLAIM_CONFIRM_MS`)
 * produced before this module was simplified. Kept unchanged on purpose: nothing about retiring the
 * lock made the risk this protects against smaller.
 *
 * **The adversary this margin is sized against is a stepped wall clock, not a slow disk.**
 * `writeJsonFileAtomic`'s own `writeFile` then `rename` is single-digit milliseconds on any disk this
 * tool runs on, so a genuinely slow write is not what 31s of headroom is for. `mtime` is wall-clock
 * time, and this machine's `CLOCK_REALTIME` steps by up to ~22.7s in either direction (WSL2's Hyper-V
 * host time sync and an active `systemd-timesyncd` both stepping it) — a step lands on every file's
 * apparent age at once, including one written a moment ago, inflating `now - mtime` by the step's
 * whole size regardless of how recently the write actually happened. Against a ~22.7s excursion,
 * 31s leaves only single-digit seconds of real margin — generous-looking, not generous in practice.
 *
 * **This cannot be hardened the way the old lock module was, and that is a known, accepted gap.**
 * `withFileLock` survived the same clock hazard by having a live holder re-stamp its own lock's mtime
 * on a heartbeat, so staleness meant "the owner's event loop has not run" rather than "old by the
 * clock," plus a second, *monotonic*-time confirmation window that told a transient clock step apart
 * from a genuinely dead holder by requiring the mtime to stay unmoved for a full second (a step here
 * lasts ~0.26s). Nothing heartbeats any more — there is no live holder's mtime to keep fresh, since
 * `.tmp-*`/`.lock` debris here means an abandoned write, not one in progress — so that confirmation
 * mechanism has nothing left to confirm and cannot be brought back as-is. What is left is a single
 * plain age check with no second signal to fall back on. Whoever revisits this number should know
 * they are trading against clock-step size, not disk speed, and that today's margin above the
 * largest step this machine has been measured producing is only ~7-8s.
 */
export const IN_PROGRESS_MS = 31_000;

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
