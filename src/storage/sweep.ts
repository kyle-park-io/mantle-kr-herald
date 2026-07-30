import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_STALE_MS, RECLAIM_CONFIRM_MS } from "../shared/store/fileLock";
import { isErrnoException } from "../shared/store/jsonFile";
import { isStrandedTempFile, lockGuarding } from "./retention";

/**
 * How recently a piece of write debris must have been touched to still count as possibly-live.
 *
 * Deliberately the lock's own reclaim point rather than a second number — **both halves of it.** A
 * lock may only be taken from its owner once it has looked stale for `LOCK_STALE_MS` *and* stayed
 * that way for `RECLAIM_CONFIRM_MS`, so a sweep that gated on `LOCK_STALE_MS` alone was the more
 * permissive of the two readers of one predicate: for one second per window, `pnpm clean --yes`
 * would delete a lock the lock module itself still refused to reclaim.
 *
 * The window's sizing argument lives on `LOCK_STALE_MS`, and it holds for a `.tmp-*` too — nothing
 * between an atomic write's `writeFile` and its `rename` waits on the network either.
 */
const IN_PROGRESS_MS = LOCK_STALE_MS + RECLAIM_CONFIRM_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A path old enough to look abandoned, and the lock whose liveness gets the last word on it. */
interface Candidate {
  path: string;
  /** Absolute path of the lock from `lockGuarding` — for a lock, itself. */
  guardian: string;
}

async function walk(dir: string, skipDir: string | undefined, now: number, found: Candidate[]): Promise<void> {
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
      // Younger than the window: a live process may still be using it, and both kinds fail the same
      // way if we take it.
      //
      // A lock that young may still belong to a running send. Removing it would let a second
      // process interleave a read-modify-write of the same ledger and drop a row.
      //
      // A `.tmp-*` that young may be an atomic write in the gap between its `writeFile` and its
      // `rename` — a window `pnpm clean --yes` runs straight into whenever a send is recording.
      // Removing it there makes the `rename` throw ENOENT, and `SendChannels` reports that as
      // "was SENT but could NOT be recorded in the ledger — a rerun will re-send it".
      //
      // Either way the cleanup command causes a duplicate live post, which is why the gate covers
      // every name `isStrandedTempFile` matches rather than only the locks.
      if (now - debris.mtimeMs < IN_PROGRESS_MS) continue;
      found.push({ path: full, guardian: join(dir, lockGuarding(name)) });
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
 * atomic write, and the lock file of a process that died mid-write. Live stores are never matched —
 * see `isStrandedTempFile`.
 *
 * **Age is not the whole test, because on a stepped clock age is not evidence.** `mtime` is compared
 * against `Date.now()`, and a wall clock that jumps forward adds its whole step to every path's
 * apparent age at once — including a lock a running send stamped milliseconds ago. (The machine this
 * was developed on steps `CLOCK_REALTIME` by ~22.7s in both directions; see `LOCK_STALE_MS`.) So
 * every candidate that passes the age gate is then checked against the lock that guards it, exactly
 * as `reclaimIfStale` checks before reclaiming:
 *
 * - **No lock at all** — nothing is holding this store, so the age gate stands on its own. That is
 *   also the only test a `.tmp-*` outside a lock ever had (the non-ledger stores write atomically
 *   without one), so nothing there is weakened.
 * - **A lock younger than `LOCK_STALE_MS`** — a live holder, beating. Everything it guards is left
 *   alone, which is what puts a `.tmp-*` back under the same verdict as the lock of the write that
 *   created it. That coupling used to be free (both were stamped once and aged together) and the
 *   heartbeat broke it, because only the lock is refreshed while the write runs.
 * - **An older lock** — wait `confirmMs` and look again. An mtime that MOVED is the holder's own
 *   proof of life and needs no clock to be read; one that did not move over a full confirmation
 *   window is a corpse, since a dead owner's mtime never changes again while a step is transient by
 *   construction.
 *
 * The wait is paid once per sweep, not once per candidate, and only when something actually reached
 * the third case. A lock older than a stale window that is genuinely being held is the pathological
 * case the heartbeat exists for; the ordinary sweep finds nothing and waits not at all.
 *
 * Walks `dir` recursively, skipping `skipDir` (the archive, which has its own retention rule).
 * Returns absolute paths; deciding what to do with them is the caller's job, so this stays safe to
 * call and easy to test.
 */
export async function collectWriteDebris(
  dir: string,
  opts: {
    skipDir?: string;
    /** How long a lock must sit unmoved to count as dead. Tests shorten it; nothing else passes it. */
    confirmMs?: number;
    /** Injectable so a test can assert the wait happens without paying for it. */
    sleep?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<string[]> {
  const confirmMs = opts.confirmMs ?? RECLAIM_CONFIRM_MS;
  const pause = opts.sleep ?? sleep;

  const candidates: Candidate[] = [];
  await walk(dir, opts.skipDir, Date.now(), candidates);
  if (candidates.length === 0) return [];

  /** Guardians that prove a live holder. Anything one of them guards is left for the next sweep. */
  const live = new Set<string>();
  /** Guardians old enough to need the confirmation window, against the mtime to compare after it. */
  const watched = new Map<string, number>();
  const seen = new Set<string>();
  for (const { guardian } of candidates) {
    if (seen.has(guardian)) continue;
    seen.add(guardian);
    const lock = await statIfPresent(guardian);
    if (!lock) continue; // no lock on this store: the age gate is the whole test, as it always was
    if (Date.now() - lock.mtimeMs <= LOCK_STALE_MS) live.add(guardian); // a live holder, beating
    else watched.set(guardian, lock.mtimeMs);
  }

  if (watched.size > 0) {
    await pause(confirmMs);
    for (const [guardian, mtimeMs] of watched) {
      const now = await statIfPresent(guardian);
      // Gone: released while we waited, so whatever it guarded is no longer in use either. Moved:
      // the holder's event loop ran, which is the one signal a stepped clock cannot fake.
      if (now && now.mtimeMs !== mtimeMs) live.add(guardian);
    }
  }

  return candidates.filter(({ guardian }) => !live.has(guardian)).map(({ path }) => path);
}
