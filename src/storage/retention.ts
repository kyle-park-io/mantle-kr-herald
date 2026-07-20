const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** Matches the suffix writeJsonFileAtomic appends: `.tmp-<pid>-<ms>-<uuid>`. */
const TEMP_FILE = /\.tmp-\d+-\d+-[0-9a-f-]+$/i;

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

export function isStrandedTempFile(name: string): boolean {
  return TEMP_FILE.test(name);
}
