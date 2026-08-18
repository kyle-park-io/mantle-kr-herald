/**
 * Google Sheets' day zero. Not 1900-01-01: Sheets reproduces Lotus 1-2-3's non-existent
 * 1900-02-29, which shifts every date one day and puts the origin here.
 */
const SHEET_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * An ISO date (or timestamp — the time is dropped) as the integer Sheets stores for it.
 *
 * A number rather than a string because every write in this codebase goes out with
 * `valueInputOption=RAW` (`GoogleSheetClient`), which stores "2026-07-03" as *text*. A column of
 * real dates would then hold one string, sorting and formatting differently from its neighbours.
 */
export function toSheetSerial(iso: string): number {
  const day = iso.slice(0, 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`not a date: ${JSON.stringify(iso)}`);
  return (ms - SHEET_EPOCH_UTC) / MS_PER_DAY;
}
