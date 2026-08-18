import type { SheetClient } from "../ports/SheetClient";
import type { KolMapEntry, KolTelegramRow } from "../domain/kol/models";
import { findLogLayout, logCells } from "../domain/kol/monthlyLog";

export interface ProjectionResult {
  month: string;
  written: number; // log rows created or refreshed
  unresolved: string[]; // kolIds with no sheetLabel — reported, never guessed
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
    const rows = await this.sheet.getValues(`${tab}!A:Z`);
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
    // The last used row, seeded at the header itself so an empty log (no data rows at all) still
    // resolves to "the row right after the header". Trailing blank rows are real in the live
    // tabs, so this walks the rows actually read rather than trusting `rows.length`.
    let lastUsedRow = layout.headerRow;
    for (let i = layout.headerRow; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNumber = i + 1;
      if (row.some((cell) => (cell ?? "").trim() !== "")) lastUsedRow = rowNumber;
      const link = (row[layout.columns.link] ?? "").trim();
      if (link === "") continue;
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
        pricePerPost: entry.pricePerPost,
      })) {
        updates.push({ range: `${tab}!${columnLetter(cell.column)}${row}`, rows: [[cell.value]] });
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

    return { month: input.month, written, unresolved };
  }
}
