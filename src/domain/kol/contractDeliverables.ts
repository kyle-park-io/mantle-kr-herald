/** What a contract says a KOL owes in one month. `unlimited` is a state, not a failure. */
export type Requirement =
  | { kind: "count"; count: number }
  | { kind: "unlimited" }
  | { kind: "unreadable"; raw: string };

export interface DeliverableTarget {
  month: string;
  kolName: string;
  requirement: Requirement;
}

/**
 * The month names the contract tab heads each block with, in column A. Order is the month number.
 */
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** `Monthly (10)` · `TG (8)` · `Monthly (unlimited)` — a kind, then a count in parentheses. */
const DELIVERABLE = /\(\s*([^)]*?)\s*\)/;

function requirementOf(raw: string): Requirement {
  const inner = DELIVERABLE.exec(raw)?.[1];
  if (inner === undefined) return { kind: "unreadable", raw };
  if (/^unlimited$/i.test(inner)) return { kind: "unlimited" };
  if (/^\d+$/.test(inner)) return { kind: "count", count: Number(inner) };
  return { kind: "unreadable", raw };
}

/**
 * Every `(month, KOL) → requirement` in the contract tab.
 *
 * Anchors on the month-name header rows rather than on row offsets: the live tab has a budget row
 * on top, a leading blank column on every data row, and one or two blank rows between blocks, and
 * all three of those move whenever someone edits it. What cannot move is that a block starts with
 * its month's name in column A.
 *
 * Throws rather than returning `[]` when no block is found. A row filed under the wrong month is a
 * count compared against the wrong target — silently — so "the layout is not what I know how to
 * read" has to stop the run.
 */
export function parseContractDeliverables(rows: string[][], year: number): DeliverableTarget[] {
  const out: DeliverableTarget[] = [];
  let month: string | undefined;
  let blocks = 0;

  for (const row of rows) {
    const first = (row[0] ?? "").trim();
    const monthIndex = MONTH_NAMES.indexOf(first.toLowerCase());
    if (monthIndex !== -1) {
      month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
      blocks += 1;
      continue;
    }
    if (month === undefined) continue;

    /**
     * A block ends at the next section, and column A is what says so: a month's data rows leave it
     * blank, while anything that opens a new section — a title, another table's header — fills it.
     *
     * Without this the parser ran to the end of the tab. The live sheet puts a `Q3 조정 단가 표`
     * (a pricing table, with its own header and its own rows) directly below the September block,
     * and the 2026-08-19 first live run reported fourteen September "targets" read out of it —
     * `"500 (최소 8건)": "$63"`, `"$75": "$75"`. Nothing reached a sheet, because a target is only
     * ever compared and reported, but the three real September rows were unfindable in the noise.
     *
     * Deliberately *ends* the block rather than skipping the row: everything below a new section
     * belongs to that section, so continuing to scan would only wait for the next such row to
     * appear. A blank column A still falls through — the blank spacer rows between blocks are not
     * terminators.
     */
    if ((row[0] ?? "").trim() !== "") {
      month = undefined;
      continue;
    }

    // Data rows carry a blank column A; the name is in B and the deliverable in C.
    const kolName = (row[1] ?? "").trim();
    const raw = (row[2] ?? "").trim();
    if (kolName === "" || kolName === "KOL") continue;
    if (raw === "") continue;
    out.push({ month, kolName, requirement: requirementOf(raw) });
  }

  if (blocks === 0) {
    throw new Error(
      "contract tab: no month block found — expected a row whose first cell is a month name " +
        "(e.g. \"July\"). Refusing rather than filing every row under an unknown month.",
    );
  }
  return out;
}
