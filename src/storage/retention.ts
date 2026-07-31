const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** Matches the suffix writeJsonFileAtomic appends: `.tmp-<pid>-<ms>-<uuid>`. */
const TEMP_FILE = /\.tmp-\d+-\d+-[0-9a-f-]+$/i;
/**
 * Matches the suffix the old cross-process file lock used to append (`<store>.lock`). Nothing
 * creates one any more — the lock was retired once the two send ledgers it protected stopped
 * needing it (see `src/adapters/store/JsonDeliveryLedger.ts`) — but an install upgraded from a build
 * that still wrote them can have one sitting on disk, and `pnpm clean` should still know to sweep it.
 */
const LOCK_FILE = /\.lock$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Archive day-folders strictly older than the retention window.
 *
 * Counts whole calendar days between the folder's date and today, and expires only when that
 * count is strictly greater than the window — a folder created exactly `olderThanDays` ago is
 * NOT "older than" that many days, and this command deletes irreplaceable data, so the boundary
 * resolves in favour of keeping. Comparing raw millisecond timestamps instead would expire the
 * boundary folder, because a folder's date anchors to midnight while `now` is part-way through
 * the day. Unparseable names are left alone rather than guessed at.
 */
export function expiredArchiveDays(names: string[], olderThanDays: number, now: Date): string[] {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return names.filter((name) => {
    if (!DAY_FOLDER.test(name)) return false;
    const at = Date.parse(`${name}T00:00:00.000Z`);
    if (Number.isNaN(at)) return false;
    return Math.round((today - at) / MS_PER_DAY) > olderThanDays;
  });
}

/**
 * Debris a crash can leave next to a live store — the temp file of an interrupted atomic write —
 * plus a stray lock file from a build old enough to still have written one. Neither is ever a store
 * the pipeline reads, so `pnpm clean` can sweep both — but only once it is old, since a `.tmp-*` is
 * also what a *running* write legitimately produces for the few milliseconds between its `writeFile`
 * and its `rename`; `collectWriteDebris` holds back anything young enough to still be that. A
 * `.lock` file carries no such risk any more — nothing acquires one, so any that exists is already
 * abandoned — but it is judged by the same age gate for one plain reason: simplicity. A single
 * uniform rule is easier to get right than a special case for a pattern that is now purely
 * historical.
 */
export function isStrandedTempFile(name: string): boolean {
  return TEMP_FILE.test(name) || LOCK_FILE.test(name);
}
