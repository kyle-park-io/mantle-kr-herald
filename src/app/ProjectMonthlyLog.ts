import type { SheetClient } from "../ports/SheetClient";
import type { KolMapEntry, KolTelegramRow } from "../domain/kol/models";
import { findLogLayout, logCells, LOG_LAST_ROW } from "../domain/kol/monthlyLog";

export interface ProjectionResult {
  month: string;
  written: number; // log rows created or refreshed
  unresolved: string[]; // kolIds with no sheetLabel — reported, never guessed
  /** Deliverable links this run could not give a row to because the log region is full at
   *  `LOG_LAST_ROW`. Reported, never written past the ceiling and never written over row
   *  `LOG_LAST_ROW` itself — see `run`. A non-empty list fails the run at the CLI. */
  overflow: string[];
}

/**
 * The price a recorded `kol-telegram-posts` row already carries, or `undefined` when it carries
 * none (or something unreadable — a blank cell and a junk cell both mean "this row has no price of
 * its own", and the roster's is the only other number available).
 *
 * This exists so the log is priced from the row that was recorded at the time, not re-derived from
 * the live roster every week: `RecordKolTelegramPosts` backfills `pricePerPost` blank-only and its
 * refresh cannot reach column K, precisely so a human can correct one row's price. Re-deriving here
 * would revert that correction weekly, and would retro-price July and August the moment a rate
 * changes in `KOL list` in September — moving `Total Cost` for months already invoiced.
 */
function recordedPrice(raw: unknown): number | undefined {
  const text = String(raw ?? "").trim();
  if (text === "") return undefined;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** 0-based column index → A1 letter. Only ever called with indices `findLogLayout` returned. */
function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Fills each month's per-post log from the posts the Telegram sweep already recorded — the sheet's
 * own summary block (COUNTIF/SUMIF over this log) is never touched, and neither is any cell outside
 * the seven value columns `logCells` names.
 *
 * A wide read (`A:Z`) rather than a range sized to the known columns: the log header's own column
 * order isn't fixed (see `monthlyLog.ts`'s `ACCEPTED` table — `Jul.` and `Aug.`/`Sep.` already
 * disagree), so the read has to see everything `findLogLayout` might need to search.
 */
export class ProjectMonthlyLog {
  constructor(
    private readonly sheet: SheetClient,
    private readonly tabForMonth: (month: string) => string,
  ) {}

  async run(input: {
    month: string;
    roster: KolMapEntry[];
    posts: KolTelegramRow[];
  }): Promise<ProjectionResult> {
    const tab = this.tabForMonth(input.month);
    // Quoted, like every other range in this feature: the live tabs are named `Jul.`/`Aug.`/`Sep.`
    // and an unquoted A1 range ending in `.` is not a range Sheets is obliged to read the way this
    // code means it.
    const rows = await this.sheet.getValues(`'${tab}'!A:Z`);
    const layout = findLogLayout(rows);
    const rosterByKolId = new Map(input.roster.map((r) => [r.kolId, r]));

    // Existing log rows, keyed on the link column — like the sheet's own `Duplicated?` formula,
    // never on a name, since a KOL's `sheetLabel` is free text a human can rename mid-quarter.
    //
    // Keep-first on a pre-existing duplicate, same policy and warning as the sibling sweep's
    // `RecordKolTelegramPosts.indexByLink` (src/app/RecordKolTelegramPosts.ts:196-213): a
    // Telegram permalink is one deliverable, so whichever row this map remembers is the one every
    // later run keeps current, and that has to be stable across runs — keeping the last-seen row
    // instead would silently swap which row is "the" row each time the tab grew, freezing the
    // other one's numbers forever while the summary's COUNTIF/SUMIF still counts both.
    const rowByLink = new Map<string, number>();
    // The append point is the row after the last row carrying a **Deliverable Link** — the log's own
    // key column — seeded at the header itself so an empty log still resolves to "the row right
    // after the header".
    //
    // Not "the last row where any A:Z cell is non-empty", which was the bug the final review found.
    // `getValues` sends no `valueRenderOption`, so it receives FORMATTED_VALUE: a formula over blank
    // inputs comes back as the string `#DIV/0!`, never as `""`. The fill-down the runbook REQUIRES
    // before this unit is enabled (the three formula columns, from the last log row down to 1963)
    // therefore makes every empty row look used, and the append point lands at 1964 — outside the
    // `SUMIF($A$12:$A$1963, …)` every summary number but `Posts` is computed from. The team would
    // see post counts climb with zero views and zero cost, and the run would still exit 0.
    let lastUsedRow = layout.headerRow;
    for (let i = layout.headerRow; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNumber = i + 1;
      const link = (row[layout.columns.link] ?? "").trim();
      if (link === "") continue;
      lastUsedRow = rowNumber;
      const first = rowByLink.get(link);
      if (first !== undefined) {
        console.warn(
          `[kol-quarter] duplicate Deliverable Link in '${tab}': ${link} is on rows ${first} and ` +
            `${rowNumber}. A Telegram permalink is one deliverable, so two rows bill it twice — row ` +
            `${first} is the one this run keeps up to date; check which row carries the human's ` +
            `verdict and delete the other.`,
        );
        continue;
      }
      rowByLink.set(link, rowNumber);
    }
    let nextFreeRow = lastUsedRow + 1;

    const unresolved: string[] = [];
    const overflow: string[] = [];
    // Rows actually touched this run, not posts processed: `ProjectionResult.written` documents
    // "log rows created or refreshed", and two posts sharing a link (see below) resolve to one row.
    const writtenRows = new Set<number>();
    // Links given a brand-new row during *this* run — mirrors `RecordKolTelegramPosts`'s
    // `appendedThisRun`, which exists for the same reason: a row this run itself just allocated
    // is not yet reflected by re-reading the sheet, so only this run's own bookkeeping can catch a
    // second post claiming a second fresh row for the same link.
    const assignedThisRun = new Set<string>();
    const updates: { range: string; rows: (string | number)[][] }[] = [];

    for (const post of input.posts) {
      const entry = rosterByKolId.get(post.kolId);
      // No sheetLabel means this KOL has no row name in this tab. Writing the kolId would invent a
      // name the summary's COUNTIF has never matched, so the post is reported instead of guessed at.
      if (!entry || entry.sheetLabel.trim() === "") {
        unresolved.push(post.kolId);
        continue;
      }

      const link = post.deliverableLink;
      let row = rowByLink.get(link);
      if (row === undefined) {
        // The log region ends at `LOG_LAST_ROW`. A post that cannot be given a row inside it is
        // reported and left unwritten: row 1963 already belongs to a real post, so overwriting it
        // would destroy that row's numbers, and writing 1964 would bill nothing while `Posts` still
        // counted it. Both are worse than a run that fails loudly with the tab intact.
        if (nextFreeRow > LOG_LAST_ROW) {
          if (overflow.length === 0) {
            console.warn(
              `[kol-quarter] '${tab}' log region is full: row ${LOG_LAST_ROW} is the last row the ` +
                `summary's SUMIF($A$12:$A$${LOG_LAST_ROW}, …) reads, and every row up to it already ` +
                `carries a Deliverable Link. No row was written past it and no existing row was ` +
                `overwritten — posts with no room are listed below and stay unlogged until a human ` +
                `extends the summary formulas' range (and the three per-row formula columns) past ` +
                `row ${LOG_LAST_ROW}, or archives this tab.`,
            );
          }
          overflow.push(link);
          continue;
        }
        row = nextFreeRow++;
        rowByLink.set(link, row);
        assignedThisRun.add(link);
      } else if (assignedThisRun.has(link)) {
        // A second post for a link this same run only just invented a row for — not one already on
        // the sheet. Left silent, this is the exact bug fixed here: `nextFreeRow++` would already
        // have moved on by the time the second post asked, handing it a second, empty row that the
        // summary's SUMIF/COUNTIF then double-counts.
        console.warn(
          `[kol-quarter] duplicate Deliverable Link within one run: ${link} was produced twice — ` +
            `row ${row} is the one kept up to date.`,
        );
      }

      for (const cell of logCells({
        layout,
        kolLabel: entry.sheetLabel,
        postedAt: post.postedAt,
        link,
        views: post.views,
        engagements: post.engagements,
        // The recorded row's own price first, the roster's only as a fallback — see `recordedPrice`.
        pricePerPost: recordedPrice(post.pricePerPost) ?? entry.pricePerPost,
      })) {
        updates.push({ range: `'${tab}'!${columnLetter(cell.column)}${row}`, rows: [[cell.value]] });
      }
      writtenRows.add(row);
    }
    const written = writtenRows.size;

    // One request for the whole run: the Sheets API allows 60 write requests per minute, and a
    // per-cell `updateValues` sweep over a quarter takes a 429 partway through — the same failure
    // `RecordImpressions` was fixed for on 2026-08-19 (PR #229).
    //
    // The cast: `SheetClient.batchUpdateValues` types a cell as `string`, which every other writer
    // satisfies by pre-stringifying. This one can't — `logCells`' posting-date cell is the number
    // `toSheetSerial` computes, and it must reach Sheets as a real number or the column holds text
    // that sorts and formats differently from its neighbours (see `toSheetSerial`'s doc). Widening
    // the port instead would ripple into the `rows: string[][]` locals in `RecordImpressions`'s,
    // `RecordKolTelegramPosts`'s, and `RecordPublish`'s tests, none of which this task touches.
    // `GoogleSheetClient` only `JSON.stringify`s `rows`, which carries a number through unchanged.
    if (updates.length > 0) {
      await this.sheet.batchUpdateValues(updates as unknown as { range: string; rows: string[][] }[]);
    }

    return { month: input.month, written, unresolved, overflow };
  }
}
