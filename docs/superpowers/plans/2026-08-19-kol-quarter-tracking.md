# KOL quarter tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly sweep fills the per-post log region of `2026 Q3 KR Work Sheet`'s monthly tabs across a whole quarter, so the summary formulas the team already wrote produce each KOL's post count against what their contract requires.

**Architecture:** The roster moves from the machine-only `kol-map` tab into the human `KOL list` tab, which is what makes writing into a human workbook safe: rows resolve through a declared roster instead of a guessed name. A pure parser reads required post counts out of the contract tab's per-month blocks, and a projector turns `kol-telegram-posts` rows into log-region cells — value columns only, addressed by header name, refusing rather than guessing when the sheet has moved.

**Tech Stack:** TypeScript (ESM, `tsx`), Google Sheets v4 values API, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-kol-quarter-tracking-design.md`

## Global Constraints

- **The summary block (rows 1–8 of each monthly tab) is never written.** `Posts`, `Views`, `Engagement`, `Total Cost` and every ratio are formulas; `followers` is the human's only value there. Spec §"What the sheet already does".
- **The machine writes values only — never a formula, never a date string.** `GoogleSheetClient` hardcodes `valueInputOption=RAW`, under which a `=…` string becomes literal text. Do NOT widen the client to `USER_ENTERED`. Spec §1.
- **`Posting date` is written as a Sheets date serial** — an integer, days since 1899-12-30. Verified: `2026-07-03` → `46206`.
- **Write surface is a declared allowlist:** the seven value columns `KOL`, `Social`/`Social media platform`, `Posting date`, `Deliverable Link`, `Content Views`, `Engagements`, `Price per posting` — plus `Topic` **only while blank**. `Organic` and the three formula columns (`Engagement Rate`, `Cost per impression`, `Duplicated?`) are never written.
- **Columns are addressed by header name, never by a bare index**, and the writer refuses when an expected header is missing or moved. Header row is *found*, not assumed to be row 11.
- **`Social` vs `Social media platform`** — `Jul.` says the first, `Aug.`/`Sep.` the second. Accept a set of spellings per logical column; never normalise the humans' headers.
- **Log rows are keyed on `Deliverable Link`**, not on any name.
- **A required-post-count parse failure never blocks and never writes** — it degrades to "target unknown" in the report.
- **`kol-map` is retired in place, not deleted.**
- Run tests with `npx vitest run <path>`; typecheck with `npx tsc --noEmit`.
- Commit subjects: conventional-commit, English sentence, may quote Korean terms.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/domain/kol/models.ts` | `KOL_LIST_HEADER`; keep `KolMapEntry` and `KOL_MAP_HEADER` unchanged (modify) |
| `src/domain/kol/contractDeliverables.ts` | **new** — pure parser for the contract tab's per-month blocks |
| `src/domain/kol/monthlyLog.ts` | **new** — pure: locate the log header, map logical columns to indices, build cell rows |
| `src/domain/metrics/sheetDate.ts` | **new** — pure: ISO date → Sheets serial |
| `src/app/LoadKolMap.ts` | read the roster from `KOL list` instead of `kol-map` (modify) |
| `src/app/ProjectMonthlyLog.ts` | **new** — reads `kol-telegram-posts`, writes the month tab's log region |
| `src/app/SweepKolQuarter.ts` | **new** — orchestrates: months of the quarter → record → project → report |
| `src/cli/kol-quarter.ts` | **new** — the `pnpm kol:quarter` entry point |
| `deploy/herald-kol-weekly.{service,timer}` | **new** — the seventh scheduled unit |
| `docs/ko/artifacts.md`, `docs/ko/capabilities.md`, `docs/ko/schedulers.md` | document the command and the timer (modify) |

---

### Task 1: The date serial

**Files:**
- Create: `src/domain/metrics/sheetDate.ts`
- Test: `tests/domain/metrics/sheetDate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function toSheetSerial(iso: string): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/metrics/sheetDate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { toSheetSerial } from "../../../src/domain/metrics/sheetDate";

/**
 * Google Sheets counts days from 1899-12-30. The expected value is not derived from the formula —
 * it is the integer the live `Jul.` tab already holds for its first logged post (2026-07-03), read
 * with `valueRenderOption=FORMULA` on 2026-08-19. A serial is written rather than a date string
 * because `GoogleSheetClient` writes with `valueInputOption=RAW`, under which "2026-07-03" lands as
 * text in a column of real dates.
 */
describe("toSheetSerial", () => {
  it("matches the serial the live sheet already stores for that date", () => {
    expect(toSheetSerial("2026-07-03")).toBe(46206);
  });

  it("counts whole days, so a later date in the same month steps by one per day", () => {
    expect(toSheetSerial("2026-07-22")).toBe(46225);
  });

  it("reads only the date, ignoring a time and zone on an ISO timestamp", () => {
    expect(toSheetSerial("2026-07-03T09:14:45.000Z")).toBe(46206);
  });

  it("refuses a value that is not a date rather than returning a number for it", () => {
    expect(() => toSheetSerial("not-a-date")).toThrow(/not-a-date/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/metrics/sheetDate.test.ts`
Expected: FAIL — "Failed to load url ../../../src/domain/metrics/sheetDate".

- [ ] **Step 3: Write the implementation**

Create `src/domain/metrics/sheetDate.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domain/metrics/sheetDate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/metrics/sheetDate.ts tests/domain/metrics/sheetDate.test.ts
git commit -m "feat(sheets): write a date as the serial Sheets stores, not a string"
```

---

### Task 2: The contract-list parser

**Files:**
- Create: `src/domain/kol/contractDeliverables.ts`
- Test: `tests/domain/kol/contractDeliverables.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```typescript
export type Requirement =
  | { kind: "count"; count: number }
  | { kind: "unlimited" }
  | { kind: "unreadable"; raw: string };

export interface DeliverableTarget {
  month: string;      // "2026-07"
  kolName: string;    // as spelled in the contract tab, e.g. "Enjoy hobby"
  requirement: Requirement;
}

export function parseContractDeliverables(rows: string[][], year: number): DeliverableTarget[];
```

`rows` is the contract tab as `getValues` returns it. Throws when no month block is recognisable.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/kol/contractDeliverables.test.ts`. The fixture is the live tab's real shape — a
`Q3 Budget` row, a leading blank column on data rows, blank separator rows between month blocks:

```typescript
import { describe, it, expect } from "vitest";
import { parseContractDeliverables } from "../../../src/domain/kol/contractDeliverables";

const LIVE = [
  ["Q3 Budget", "$10,000", "Current Expense", "10000", "Remained", "$0"],
  [""],
  ["July", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
  ["", "Marine", "Monthly (10)", "1000", "Soloved", "https://etherscan.io/tx/0x97c0"],
  ["", "Raoni", "Monthly (unlimited)", "900", "Soloved", ""],
  ["", "Enjoy hobby", "Monthly (8)", "500", "Non soloved"],
  ["", "GMB", "TG (8)", "600", "Non soloved"],
  ["", " Leedogin", "TG (12)", "1100", "Non soloved"],
  [""],
  [""],
  ["August", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
  ["", "Marine", "Monthly (10)", "1000"],
  ["", "Coinboy", "매월 5회", "500"],
];

describe("parseContractDeliverables", () => {
  it("reads a count out of both spellings of the deliverable", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({ month: "2026-07", kolName: "Marine", requirement: { kind: "count", count: 10 } });
    expect(out).toContainEqual({ month: "2026-07", kolName: "GMB", requirement: { kind: "count", count: 8 } });
  });

  /** `unlimited` is a real contract state — no target — not a parse failure. */
  it("reads unlimited as its own state", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({ month: "2026-07", kolName: "Raoni", requirement: { kind: "unlimited" } });
  });

  it("carries an unreadable deliverable through as unreadable, with the text that confused it", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({
      month: "2026-08", kolName: "Coinboy", requirement: { kind: "unreadable", raw: "매월 5회" },
    });
  });

  it("attributes each row to the month block above it, not to the first block", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    const marine = out.filter((t) => t.kolName === "Marine").map((t) => t.month);
    expect(marine).toEqual(["2026-07", "2026-08"]);
  });

  it("trims the stray leading space the live tab has on one name", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out.some((t) => t.kolName === "Leedogin")).toBe(true);
  });

  it("ignores the budget header and the blank separator rows", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out.some((t) => t.kolName === "" || t.kolName === "KOL" || t.kolName === "Q3 Budget")).toBe(false);
  });

  /**
   * Refusing beats mis-attributing. If the month headers are gone, every row would otherwise be
   * filed under whatever block the parser last saw — or under none — and a count silently attached
   * to the wrong month is worse than no count at all.
   */
  it("throws when no month block can be recognised", () => {
    expect(() => parseContractDeliverables([["KOL", "Deliverables"], ["Marine", "Monthly (10)"]], 2026))
      .toThrow(/month/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/domain/kol/contractDeliverables.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/domain/kol/contractDeliverables.ts`:

```typescript
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/domain/kol/contractDeliverables.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/kol/contractDeliverables.ts tests/domain/kol/contractDeliverables.test.ts
git commit -m "feat(kol): read each month's required post count off the contract tab"
```

---

### Task 3: Locating the log region

**Files:**
- Create: `src/domain/kol/monthlyLog.ts`
- Test: `tests/domain/kol/monthlyLog.test.ts`

**Interfaces:**
- Consumes: `toSheetSerial` (Task 1).
- Produces:

```typescript
export interface LogLayout {
  headerRow: number;                        // 1-based sheet row of the log header
  columns: Record<LogColumn, number>;       // 0-based column index per logical column
}
export type LogColumn =
  | "kol" | "social" | "postedAt" | "link" | "topic"
  | "views" | "engagements" | "pricePerPost";

export function findLogLayout(rows: string[][]): LogLayout;   // throws when not found
export function logCells(input: {
  layout: LogLayout;
  kolLabel: string;
  postedAt: string;
  link: string;
  views: number;
  engagements: number;
  pricePerPost: number;
}): { column: number; value: string | number }[];
```

- [ ] **Step 1: Write the failing test**

Create `tests/domain/kol/monthlyLog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findLogLayout, logCells } from "../../../src/domain/kol/monthlyLog";

/** The live `Aug.` shape: summary block, two blank rows, then the log header on row 11. */
const AUG = [
  ["KOL", "followers", "Posts", "Views", "Avg.views", "Engagement"],
  ["Raoni", "13,675", "0", "0", "#DIV/0!", "0"],
  [""],
  [""],
  ["KOL", "Social media platform", "Posting date", "Deliverable Link", "Topic",
   "Content Views", "Engagements", "Engagement Rate", "Price per posting",
   "Cost per impression", "Organic", "Duplicated?"],
];

/** `Jul.` heads the same column `Social`, not `Social media platform`. */
const JUL = AUG.map((r, i) => (i === 4 ? r.map((c) => (c === "Social media platform" ? "Social" : c)) : r));

describe("findLogLayout", () => {
  it("finds the header row rather than assuming one", () => {
    expect(findLogLayout(AUG).headerRow).toBe(5);
  });

  /**
   * The summary block above the log grows when a KOL joins the roster, so the header moves. A
   * hardcoded row would then write a post's data on top of somebody's formulas.
   */
  it("still finds it when the summary block above has grown", () => {
    const grown = [AUG[0], AUG[1], AUG[1], AUG[1], AUG[2], AUG[3], AUG[4]];
    expect(findLogLayout(grown).headerRow).toBe(7);
  });

  it("accepts either spelling of the platform column", () => {
    expect(findLogLayout(AUG).columns.social).toBe(1);
    expect(findLogLayout(JUL).columns.social).toBe(1);
  });

  it("maps every logical column to the position it actually sits in", () => {
    expect(findLogLayout(AUG).columns).toEqual({
      kol: 0, social: 1, postedAt: 2, link: 3, topic: 4,
      views: 5, engagements: 6, pricePerPost: 8,
    });
  });

  /** A column inserted by hand shifts the rest; the map must follow, not offset blindly. */
  it("follows a column inserted by a human", () => {
    const shifted = AUG.map((r, i) => (i === 4 ? [r[0], "메모", ...r.slice(1)] : r));
    expect(findLogLayout(shifted).columns.social).toBe(2);
    expect(findLogLayout(shifted).columns.link).toBe(4);
  });

  it("throws when an expected column is missing, naming it", () => {
    const noLink = AUG.map((r, i) => (i === 4 ? r.filter((c) => c !== "Deliverable Link") : r));
    expect(() => findLogLayout(noLink)).toThrow(/Deliverable Link/);
  });

  it("throws when there is no log header at all", () => {
    expect(() => findLogLayout([AUG[0], AUG[1]])).toThrow(/log header/i);
  });
});

describe("logCells", () => {
  const layout = findLogLayout(AUG);

  it("emits only the seven value columns, and the date as a serial", () => {
    const cells = logCells({
      layout, kolLabel: "Marine", postedAt: "2026-07-03T09:14:45.000Z",
      link: "https://t.me/marshallog/22794", views: 2800, engagements: 3, pricePerPost: 100,
    });
    expect(cells).toEqual([
      { column: 0, value: "Marine" },
      { column: 1, value: "Telegram" },
      { column: 2, value: 46206 },
      { column: 3, value: "https://t.me/marshallog/22794" },
      { column: 5, value: 2800 },
      { column: 6, value: 3 },
      { column: 8, value: 100 },
    ]);
  });

  /** Topic is a human column, filled elsewhere and only while blank; the formulas are never ours. */
  it("never emits topic, organic, or a formula column", () => {
    const cells = logCells({
      layout, kolLabel: "Marine", postedAt: "2026-07-03", link: "l",
      views: 1, engagements: 1, pricePerPost: 1,
    });
    expect(cells.map((c) => c.column)).not.toContain(layout.columns.topic);
    for (const forbidden of [7, 9, 10, 11]) expect(cells.map((c) => c.column)).not.toContain(forbidden);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/domain/kol/monthlyLog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/domain/kol/monthlyLog.ts`:

```typescript
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/domain/kol/monthlyLog.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/kol/monthlyLog.ts tests/domain/kol/monthlyLog.test.ts
git commit -m "feat(kol): find the monthly log's header and columns instead of assuming them"
```

---

### Task 4: The roster moves to `KOL list`

**Files:**
- Modify: `src/domain/kol/models.ts` (add `KOL_LIST_HEADER`)
- Modify: `src/app/LoadKolMap.ts:7` (`KOL_MAP_RANGE`) and its header lookup
- Test: `tests/app/loadKolMap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LoadKolMap.run()` unchanged in shape — still `Promise<KolMapEntry[]>` — but sourced from `'KOL list'!A:Z`. `KOL_LIST_HEADER` names the columns it reads.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/loadKolMap.test.ts`, matching the file's existing sheet-stub shape:

```typescript
  /**
   * The roster moved out of the machine-only `kol-map` tab into the humans' `KOL list`, which is
   * what lets a monthly-tab row be resolved through a declared roster instead of a guessed name.
   * `Social media link` was already there and empty, and `extractTelegramHandle` already reads all
   * four spellings a human might put in it, so no new handle column was added.
   */
  it("reads the roster from 'KOL list', taking the handle from Social media link", async () => {
    const sheet = stubSheet({
      "'KOL list'!A:Z": [
        ["KOL", "KOL Type", "Social media", "Content Price", "Social media link", "Note",
         "kolId", "sheetLabel", "pricePerPost", "active"],
        ["In contract"],
        ["Marshall", "General", "Telegram", "150", "https://t.me/marshallog", "",
         "marine", "Marine", "100", "TRUE"],
        ["Cek", "General", "Telegram", "125", "@airdr0p_lab", "",
         "cek", "CEK", "60", "TRUE"],
      ],
    });

    const entries = await new LoadKolMap(sheet).run();

    expect(entries).toEqual([
      { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
      { kolId: "cek", tgHandle: "airdr0p_lab", sheetLabel: "CEK", pricePerPost: 60, active: true },
    ]);
  });

  it("skips a section row like 'In contract', which carries no kolId", async () => {
    const sheet = stubSheet({
      "'KOL list'!A:Z": [
        ["KOL", "Social media link", "kolId", "sheetLabel", "pricePerPost", "active"],
        ["In contract"],
        ["Marshall", "https://t.me/marshallog", "marine", "Marine", "100", "TRUE"],
      ],
    });
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["marine"]);
  });
```

Adapt `stubSheet` to whatever the file already uses to serve a range; do not introduce a second stub shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/loadKolMap.test.ts`
Expected: FAIL — the loader still asks for `'kol-map'!A:Z`.

- [ ] **Step 3: Add the header constant**

In `src/domain/kol/models.ts`, beside `KOL_MAP_HEADER`:

```typescript
/**
 * The columns `LoadKolMap` reads out of the humans' `KOL list` tab. Four are new (`kolId`,
 * `sheetLabel`, `pricePerPost`, `active`); `Social media link` was already there and empty.
 *
 * `pricePerPost` is separate from the tab's existing `Content Price` on purpose: that column is
 * free text a human negotiates in (`150~180`, `0.01`) and disagrees with this one (Marine is 150
 * there, 100 here) because they measure different things. Merging them would fabricate agreement.
 */
export const KOL_LIST_HEADER = ["kolId", "Social media link", "sheetLabel", "pricePerPost", "active"] as const;
```

- [ ] **Step 4: Point the loader at the new tab**

In `src/app/LoadKolMap.ts`, replace the range and the handle column lookup:

```typescript
// The roster lives in the humans' `KOL list` tab; `kol-map` is retired (see the 2026-08-19
// kol-quarter-tracking spec). Update here if the tab is renamed.
const KOL_MAP_RANGE = "'KOL list'!A:Z";
```

and source `COL_TG_HANDLE` from `"Social media link"` rather than `"tgHandle"`, leaving
`COL_KOL_ID`, `COL_SHEET_LABEL`, `COL_PRICE` and `COL_ACTIVE` as they are — the four new columns
carry exactly those header names. Keep every existing behaviour: the currency prefix tolerance, the
whole-string numeric test, `isActive`, and the warn-and-skip on an unreadable handle.

A row whose `kolId` cell is empty is skipped — that is what makes the `In contract` section row and
the header row harmless without teaching the loader about either.

- [ ] **Step 5: Run the loader's whole test file**

Run: `npx vitest run tests/app/loadKolMap.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck. Existing cases that fed `'kol-map'!A:Z` need their range key
renamed — that is the signature change, not a behaviour change; their expected entries must not move.

- [ ] **Step 6: Commit**

```bash
git add src/domain/kol/models.ts src/app/LoadKolMap.ts tests/app/loadKolMap.test.ts
git commit -m "feat(kol): read the roster from the team's KOL list, not the machine's kol-map"
```

---

### Task 5: Projecting posts into the month's log

**Files:**
- Create: `src/app/ProjectMonthlyLog.ts`
- Test: `tests/app/projectMonthlyLog.test.ts`

**Interfaces:**
- Consumes: `findLogLayout`, `logCells`, `LogLayout` (Task 3); `KolMapEntry` (Task 4); `SheetClient`.
- Produces:

```typescript
export interface ProjectionResult {
  month: string;
  written: number;      // log rows created or refreshed
  unresolved: string[]; // kolIds with no sheetLabel — reported, never guessed
}
export class ProjectMonthlyLog {
  constructor(sheet: SheetClient, tabForMonth: (month: string) => string);
  run(input: { month: string; roster: KolMapEntry[]; posts: KolTelegramRow[] }): Promise<ProjectionResult>;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/app/projectMonthlyLog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { ProjectMonthlyLog } from "../../src/app/ProjectMonthlyLog";
import type { SheetClient } from "../../src/ports/SheetClient";

const HEADER = ["KOL", "Social media platform", "Posting date", "Deliverable Link", "Topic",
  "Content Views", "Engagements", "Engagement Rate", "Price per posting",
  "Cost per impression", "Organic", "Duplicated?"];

function harness(existing: string[][]) {
  const batches: { range: string; rows: (string | number)[][] }[] = [];
  const sheet = {
    getValues: async () => existing,
    appendValues: async () => { throw new Error("must not append — rows are addressed by row number"); },
    updateValues: async () => { throw new Error("must not use per-cell updateValues"); },
    batchUpdateValues: async (updates: { range: string; rows: (string | number)[][] }[]) => {
      batches.push(...updates);
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  } as unknown as SheetClient;
  return { sheet, batches };
}

const roster = [
  { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
  { kolId: "gmb", tgHandle: "GMBLABS", sheetLabel: "", pricePerPost: 75, active: true },
];

const post = (over: Record<string, unknown> = {}) => ({
  kolId: "marine", tgHandle: "marshallog", postedAt: "2026-07-03T09:14:45.000Z",
  deliverableLink: "https://t.me/marshallog/22794", views: 2800, engagements: 3,
  reactionsDetail: "", itemId: "", topic: "", matchScore: "", pricePerPost: 100,
  fetchedAt: "", confirmed: "", ...over,
}) as never;

describe("ProjectMonthlyLog", () => {
  it("appends a post the log does not have yet, below the last used row", async () => {
    const h = harness([["KOL", "followers"], ["Marine", "1"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post()] });

    expect(res.written).toBe(1);
    expect(h.batches.map((b) => b.range)).toEqual([
      "Jul.!A6", "Jul.!B6", "Jul.!C6", "Jul.!D6", "Jul.!F6", "Jul.!G6", "Jul.!I6",
    ]);
    expect(h.batches.map((b) => b.rows[0][0])).toEqual([
      "Marine", "Telegram", 46206, "https://t.me/marshallog/22794", 2800, 3, 100,
    ]);
  });

  /** Keyed on the link, like the sheet's own `Duplicated?` formula — never on a name. */
  it("refreshes a post already in the log, in place", async () => {
    const h = harness([
      ["KOL", "followers"], ["Marine", "1"], [""], [""], HEADER,
      ["Marine", "Telegram", "46206", "https://t.me/marshallog/22794", "USPXx Live", "1000", "1", "", "100"],
    ]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post({ views: 2800 })] });

    expect(res.written).toBe(1);
    expect(h.batches.every((b) => b.range.endsWith("6"))).toBe(true);
    expect(h.batches.map((b) => b.range)).not.toContain("Jul.!E6"); // Topic survives
  });

  it("never writes Topic, Organic, or a formula column", async () => {
    const h = harness([["KOL"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");
    await uc.run({ month: "2026-07", roster, posts: [post()] });
    for (const col of ["E", "H", "J", "K", "L"]) {
      expect(h.batches.map((b) => b.range).some((r) => r.includes(`!${col}`))).toBe(false);
    }
  });

  /**
   * A KOL with no sheetLabel has no row name in this tab. Writing the kolId would invent a name the
   * summary's COUNTIF has never matched, so the post is reported instead.
   */
  it("reports a post whose KOL has no sheetLabel, and writes nothing for it", async () => {
    const h = harness([["KOL"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post({ kolId: "gmb" })] });

    expect(res.written).toBe(0);
    expect(res.unresolved).toEqual(["gmb"]);
    expect(h.batches).toEqual([]);
  });

  it("is idempotent — a second run writes the same cells and adds no row", async () => {
    const existing = [["KOL"], [""], [""], HEADER];
    const h = harness(existing);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");
    const first = await uc.run({ month: "2026-07", roster, posts: [post()] });
    const ranges = h.batches.map((b) => b.range);
    h.batches.length = 0;
    // Feed back what the first run wrote, as the sheet would now return it.
    existing.push(["Marine", "Telegram", "46206", "https://t.me/marshallog/22794", "", "2800", "3", "", "100"]);
    const second = await uc.run({ month: "2026-07", roster, posts: [post()] });
    expect(second.written).toBe(first.written);
    expect(h.batches.map((b) => b.range)).toEqual(ranges);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/projectMonthlyLog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/app/ProjectMonthlyLog.ts`. It reads the tab once, locates the layout with
`findLogLayout`, indexes existing log rows by their `Deliverable Link` cell, and for each post emits
`logCells` as one `batchUpdateValues` entry **per cell** so no cell outside the allowlist can ever be
inside a written range. The range building is where this goes wrong, so it is spelled out:

```typescript
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

const updates = [];
for (const post of input.posts) {
  const entry = rosterByKolId.get(post.kolId);
  // No sheetLabel means this KOL has no row name in this tab. Writing the kolId would invent a name
  // the summary's COUNTIF has never matched, so the post is reported instead of guessed at.
  if (!entry || entry.sheetLabel.trim() === "") { unresolved.push(post.kolId); continue; }

  const row = rowByLink.get(post.deliverableLink) ?? nextFreeRow++;
  for (const cell of logCells({ layout, kolLabel: entry.sheetLabel, postedAt: post.postedAt,
    link: post.deliverableLink, views: post.views, engagements: post.engagements,
    pricePerPost: entry.pricePerPost })) {
    updates.push({ range: `${tab}!${columnLetter(cell.column)}${row}`, rows: [[cell.value]] });
  }
  written += 1;
}
if (updates.length > 0) await this.sheet.batchUpdateValues(updates);
```

`nextFreeRow` starts at the first row after the last non-empty log row — computed from the rows read,
not from a row count, because trailing blank rows exist in the live tabs.

One `batchUpdateValues` call carries every cell of the run: the Sheets API allows 60 write requests
per minute, and a per-cell `updateValues` sweep over a quarter would take a 429 partway through —
the failure `RecordImpressions` was already fixed for on 2026-08-19 (PR #229).

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/app/projectMonthlyLog.test.ts && npx tsc --noEmit`
Expected: PASS (6 tests), clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/app/ProjectMonthlyLog.ts tests/app/projectMonthlyLog.test.ts
git commit -m "feat(kol): project swept posts into the monthly tab's log, values only"
```

---

### Task 6: The quarter sweep and its command

**Files:**
- Create: `src/app/SweepKolQuarter.ts`, `src/cli/kol-quarter.ts`
- Modify: `package.json` (add the `kol:quarter` script)
- Test: `tests/app/sweepKolQuarter.test.ts`

**Interfaces:**
- Consumes: `parseContractDeliverables` (Task 2), `ProjectMonthlyLog` (Task 5), `LoadKolMap` (Task 4), `RecordKolTelegramPosts` (existing).
- Produces:

```typescript
export function monthsOfQuarter(quarter: string): string[];  // "2026-Q3" -> ["2026-07","2026-08","2026-09"]
export interface QuarterReport {
  quarter: string;
  months: { month: string; written: number; unresolved: string[] }[];
  shortfalls: { month: string; kolName: string; actual: number; required: number }[];
  unknownTargets: { month: string; kolName: string; raw: string }[];
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/app/sweepKolQuarter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { monthsOfQuarter } from "../../src/app/SweepKolQuarter";

describe("monthsOfQuarter", () => {
  it("expands a quarter into its three months", () => {
    expect(monthsOfQuarter("2026-Q3")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(monthsOfQuarter("2026-Q1")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("refuses anything that is not a quarter, rather than sweeping a guess", () => {
    expect(() => monthsOfQuarter("2026-07")).toThrow(/quarter/i);
    expect(() => monthsOfQuarter("2026-Q5")).toThrow(/quarter/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/app/sweepKolQuarter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `monthsOfQuarter` and the orchestrator**

```typescript
const QUARTER = /^(\d{4})-Q([1-4])$/;

/** `"2026-Q3"` → the quarter's three months. Throws on anything else — a mis-read quarter would
 *  sweep the wrong tabs and file counts against the wrong contracts. */
export function monthsOfQuarter(quarter: string): string[] {
  const m = QUARTER.exec(quarter.trim());
  if (!m) throw new Error(`not a quarter: ${JSON.stringify(quarter)} — expected e.g. "2026-Q3"`);
  const year = m[1];
  const first = (Number(m[2]) - 1) * 3 + 1;
  return [0, 1, 2].map((i) => `${year}-${String(first + i).padStart(2, "0")}`);
}
```

`SweepKolQuarter.run({ quarter })` then, for each month: runs the existing
`RecordKolTelegramPosts` sweep, reads `kol-telegram-posts`, projects that month's rows with
`ProjectMonthlyLog`, and finally compares each KOL's projected count against
`parseContractDeliverables`. A `count` requirement below the actual is a `shortfall`; `unlimited`
produces nothing; `unreadable` goes to `unknownTargets`. **Nothing about the comparison is written
to any sheet** — it is the run's report only.

- [ ] **Step 4: Write the CLI**

Create `src/cli/kol-quarter.ts` following `src/cli/kol-telegram-record.ts`'s shape: `skipIfLocal`,
`createGoogleAuth`, `GoogleSheetClient`, `argValue("--quarter")` defaulting to the quarter containing
today, then print the report — per month `written`/`unresolved`, then shortfalls as
`<KOL> <actual>/<required>`, then unknown targets. Add to `package.json`:

```json
"kol:quarter": "tsx --env-file-if-exists=.env src/cli/kol-quarter.ts",
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/app/sweepKolQuarter.test.ts && npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/app/SweepKolQuarter.ts src/cli/kol-quarter.ts package.json tests/app/sweepKolQuarter.test.ts
git commit -m "feat(kol): sweep a whole quarter, and report each KOL against their contract"
```

---

### Task 7: The weekly unit

**Files:**
- Create: `deploy/herald-kol-weekly.service`, `deploy/herald-kol-weekly.timer`
- Test: `tests/deploy/kolWeekly.test.ts`

**Interfaces:**
- Consumes: `pnpm kol:quarter` (Task 6). Produces: no code.

- [ ] **Step 1: Write the failing test**

Create `tests/deploy/kolWeekly.test.ts`, following whatever `tests/deploy/` already does to read a
unit file:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const service = readFileSync("deploy/herald-kol-weekly.service", "utf8");
const timer = readFileSync("deploy/herald-kol-weekly.timer", "utf8");

describe("herald-kol-weekly", () => {
  it("runs the quarter sweep and nothing else", () => {
    const execs = service.split("\n").filter((l) => l.startsWith("ExecStart="));
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain("pnpm kol:quarter");
  });

  /** Every scheduled unit pages the ops room on failure; a silent weekly failure is invisible. */
  it("pages the ops room on failure", () => {
    expect(service).toContain("OnFailure=herald-notify-failure@%n.service");
  });

  it("runs from the deploy checkout with the production env, like its siblings", () => {
    expect(service).toContain("WorkingDirectory=%h/.herald/app");
    expect(service).toContain("EnvironmentFile=%h/.herald/prod.env");
  });

  it("fires weekly", () => {
    expect(timer).toMatch(/OnCalendar=\w{3} \*-\*-\* /);
    expect(timer).toContain("Persistent=true");
  });

  /** Sends and publishes are not this unit's business, the same rule the other six follow. */
  it("never sends or publishes", () => {
    for (const word of ["send:", "drive:publish", "format "]) expect(service).not.toContain(word);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/deploy/kolWeekly.test.ts`
Expected: FAIL — ENOENT on the unit files.

- [ ] **Step 3: Write the units**

`deploy/herald-kol-weekly.service`, modelled on `herald-translate-check.service` — a header comment
saying what it does and what it must never do, `Type=oneshot`,
`OnFailure=herald-notify-failure@%n.service`, `WorkingDirectory=%h/.herald/app`, the same `PATH` and
`HERALD_OUTPUT_DIR` environment lines, `EnvironmentFile=%h/.herald/prod.env`, a `TimeoutStartSec=`
sized for three months of t.me pagination, and one
`ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm kol:quarter`.

`deploy/herald-kol-weekly.timer` with `OnCalendar=Tue *-*-* 07:23:00` — a different day and minute
from `herald-translate-check.timer`'s `Mon *-*-* 06:53:00`, so two weekly sweeps never contend for
the Sheets write quota — plus `Persistent=true` and `WantedBy=timers.target`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/deploy/kolWeekly.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/herald-kol-weekly.service deploy/herald-kol-weekly.timer tests/deploy/kolWeekly.test.ts
git commit -m "feat(deploy): sweep the quarter's KOL deliverables on a weekly timer"
```

---

### Task 8: Migration and documentation

**Files:**
- Create: `src/cli/kol-roster-migrate.ts`
- Modify: `docs/ko/artifacts.md`, `docs/ko/capabilities.md`, `docs/ko/schedulers.md`, `docs/ko/kol-map-seed.md`
- Test: none — this is a one-shot operator script plus prose.

**Interfaces:**
- Consumes: everything above. Produces: no code others use.

- [ ] **Step 1: Write the migration script**

`src/cli/kol-roster-migrate.ts`, `--yes`-gated like `state:pull`: reads `'kol-map'!A:Z` and
`'KOL list'!A:Z`, matches a kol-map row to a KOL-list row by the handle in `Social media link`
(falling back to no match rather than to a name guess), and prints the plan — which rows it would
fill, and every kol-map row it cannot place. Without `--yes` it writes nothing. With `--yes` it
fills the four new columns and the handle where blank, then writes `(은퇴 — KOL list로 이관)` into
`'kol-map'!A1`.

Six of the thirteen kol-map rows have no `sheetLabel`, and some name KOLs absent from the monthly
tabs entirely; those are expected to come back as unplaceable and are a human's call.

- [ ] **Step 2: Run it as a preview against the live workbook**

Run: `pnpm tsx src/cli/kol-roster-migrate.ts`
Expected: a plan naming 13 kol-map rows, with the unplaceable ones listed. **Do not pass `--yes`
here** — the operator does that after reading the plan.

- [ ] **Step 3: Extend the log region's formulas and date format, once per monthly tab**

This is the spec's migration step 2, and it is a **human** step — the machine never writes a formula
(Global Constraints). Without it the sweep's new rows carry values but no ratios: `Aug.`'s formulas
stop at row 17 today, so row 18 onward would show blank `Engagement Rate` and `Cost per impression`.

In each of `Jul.`, `Aug.`, `Sep.`, select the last log row that already has them and fill down to
row **1963** — the row the summary's `SUMIF($A$12:$A$1963, …)` already reaches, so nothing beyond it
would be counted anyway. The three formulas, as they read on `Jul.` row 12:

| column | formula |
| --- | --- |
| `Engagement Rate` (H) | `=G12/F12` |
| `Cost per impression` (J) | `=I12/F12` |
| `Duplicated?` (L) | `=COUNTIF(D:D,D12)` |

Fill the `Posting date` column's **number format** down the same range in the same action, or a
written serial renders as `46206` instead of `07/03/26`.

Verify by reading one untouched row back with `valueRenderOption=FORMULA` and confirming the three
formulas are present at row 1963 — the same read that would have caught this plan's first design
error.

- [ ] **Step 4: Document the command and the timer**

- `docs/ko/artifacts.md`: a row for `pnpm kol:quarter` naming its inputs (`'KOL list'` 로스터,
  ` Q3 KOL 계약 리스트`의 `Deliverables`, `kol-telegram-posts`) and its outputs (월별 탭 로그 영역의
  **값 일곱 열 + 빈 칸일 때만 `Topic`**), and one for `pnpm kol-roster-migrate`.
- `docs/ko/schedulers.md`: the seventh timer in the table, with its cadence and what it never does.
- `docs/ko/capabilities.md`: the capability row, stating that the summary block and `followers`
  stay human-owned and that the sheet's own formulas do the counting.
- `docs/ko/kol-map-seed.md`: a note at the top that the roster now lives in `KOL list` and this
  document describes the retired tab.

- [ ] **Step 5: Run the docs tests**

Run: `npx vitest run tests/docs && npx vitest run`
Expected: PASS, whole suite green.

- [ ] **Step 6: Commit**

```bash
git add src/cli/kol-roster-migrate.ts docs/ko
git commit -m "feat(kol): migrate the roster into KOL list, and document the weekly sweep"
```

---

## Deployment

No schema change, so the ordinary order applies — but the new timer must be installed by hand, as
the other six were:

```bash
pnpm deploy:check
bash deploy/herald-deploy.sh --yes
cp deploy/herald-kol-weekly.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now herald-kol-weekly.timer
systemctl --user list-timers 'herald-*'
pnpm doctor
```

A Vercel redeploy is not needed: nothing here touches `web/`, an API route, or an environment
variable.
