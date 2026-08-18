import { toSheetSerial } from "../metrics/sheetDate";

export type LogColumn =
  | "kol" | "social" | "postedAt" | "link" | "topic"
  | "views" | "engagements" | "pricePerPost";

export interface LogLayout {
  headerRow: number;
  columns: Record<LogColumn, number>;
}

/**
 * Accepted header spellings per logical column, and the one place a new divergence gets added.
 *
 * `social` carries two because the humans' tabs disagree: `Jul.` heads it `Social`, `Aug.` and
 * `Sep.` head it `Social media platform`. Normalising their headers would be this code editing a
 * tab it has no reason to touch, so it reads both instead.
 */
const ACCEPTED: Record<LogColumn, string[]> = {
  kol: ["KOL"],
  social: ["Social", "Social media platform"],
  postedAt: ["Posting date"],
  link: ["Deliverable Link"],
  topic: ["Topic"],
  views: ["Content Views"],
  engagements: ["Engagements"],
  pricePerPost: ["Price per posting"],
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The last row of the log region — the row the summary block's own
 * `SUMIF($A$12:$A$1963, …)` reaches, read off the live workbook.
 *
 * A log row below it is invisible to `Views`, `Engagement` and `Total Cost`, while `Posts`
 * (`=COUNTIF(A11:A, …)`, open-ended) still counts it: the team would watch post counts climb
 * against zero views and zero cost. So this is a hard ceiling on where a new row may be allocated,
 * not a hint — and a full log is reported rather than written past or written over.
 */
export const LOG_LAST_ROW = 1963;

/** The header row is the first row that carries every column above. */
export function findLogLayout(rows: string[][]): LogLayout {
  for (const [i, row] of rows.entries()) {
    const cells = row.map(norm);
    if (!ACCEPTED.link.some((h) => cells.includes(norm(h)))) continue;

    const columns = {} as Record<LogColumn, number>;
    const missing: string[] = [];
    for (const key of Object.keys(ACCEPTED) as LogColumn[]) {
      const at = cells.findIndex((c) => ACCEPTED[key].some((h) => norm(h) === c));
      if (at === -1) missing.push(ACCEPTED[key][0]!);
      else columns[key] = at;
    }
    if (missing.length > 0) {
      throw new Error(
        `monthly log header found on row ${i + 1} but missing column(s): ${missing.join(", ")}. ` +
          "Refusing rather than writing to a guessed position.",
      );
    }
    return { headerRow: i + 1, columns };
  }
  throw new Error(
    "no log header found — expected a row carrying \"Deliverable Link\". The summary block above " +
      "the log grows as the roster does, so the row is searched for rather than assumed.",
  );
}

/**
 * The cells one post contributes — the seven value columns and nothing else.
 *
 * `topic` is deliberately absent: it is a human column, backfilled only while blank by the writer,
 * so emitting it here would let a refresh overwrite somebody's wording. The three formula columns
 * are absent for a harder reason — `GoogleSheetClient` writes `RAW`, which would store a formula as
 * literal text; they are filled down once by migration instead.
 */
export function logCells(input: {
  layout: LogLayout;
  kolLabel: string;
  postedAt: string;
  link: string;
  views: number;
  engagements: number;
  pricePerPost: number;
}): { column: number; value: string | number }[] {
  const c = input.layout.columns;
  return [
    { column: c.kol, value: input.kolLabel },
    { column: c.social, value: "Telegram" },
    { column: c.postedAt, value: toSheetSerial(input.postedAt) },
    { column: c.link, value: input.link },
    { column: c.views, value: input.views },
    { column: c.engagements, value: input.engagements },
    { column: c.pricePerPost, value: input.pricePerPost },
  ].sort((a, b) => a.column - b.column);
}
