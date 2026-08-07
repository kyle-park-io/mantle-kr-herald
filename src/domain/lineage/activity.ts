import type { LineageEvent } from "./models";

/**
 * A date × stage rollup of the append-only `lineage` table — "when did what happen".
 *
 * **Why this is not a `status` query.** Every other pipeline count in this codebase reads a
 * `status` column, which holds where a record is *right now*. That is a different question, and
 * confusing the two has already cost a wrong conclusion: `select status, count(*) from
 * translations` reported `approved = 0` and was read as "nobody has approved anything in ten
 * days", when in fact `x:reconcile` retires a published item to `posted` and 18 of the 21 `posted`
 * rows had never carried an `approved_at` at all. `src/status/pipeline.ts`'s `translatedNote`
 * documents that trap from the other side. `lineage` is the only append-only table in the schema
 * (`src/adapters/db/schema.ts`), so it is the only place a past event still exists after the record
 * moved on — hence this module reads `lineage` and nothing else.
 *
 * Pure: no store, no clock, no I/O. The CLI (`src/cli/lineage.ts`) does the reading.
 */

/**
 * Who wrote a lineage row, derived from the row's own `(stage, status)` and nothing else — the
 * table records no author.
 *
 * The split is **not** by stage, which is the natural guess and is wrong in both directions. It
 * comes from reading every caller of `LineageStore.append` and then every construction site of the
 * five use-cases that own those calls:
 *
 * | shape                    | writers                                                                    |
 * |--------------------------|----------------------------------------------------------------------------|
 * | `converted`              | `SaveConversion` ← `pnpm convert:save` only. `apiHandlers` never builds it. |
 * | `translated` unapproved  | `SaveTranslation` ← `pnpm translate:save` (the scheduler's agent, every tick) **and** the dashboard's 1차 text edit and its 승인 취소 (`apiHandlers.ts:357,378`, both `approve: false`) |
 * | `rendered` unapproved    | `SaveRendering` ← `pnpm format:save` **and** the dashboard's rendering edit (`apiHandlers.ts:456`); also `ApproveRendering` withdrawing an approval (`:465`, `approve: false`) |
 * | `translated` + approved  | `SaveTranslation` with `approve: true` — 1차 승인 (`apiHandlers.ts:364`)     |
 * | `rendered` + approved    | `ApproveRendering` — 2차 검수, dashboard-only (`apiHandlers.ts:465`)         |
 * | `forked` (any status)    | `SaveOutletOverride` — built only in `createDeps.ts:542`, i.e. dashboard-only |
 *
 * So:
 * - **`machine`** — no human path exists. Only `converted` qualifies.
 * - **`human`** — no machine path exists. Both `approved` shapes and every `forked` shape.
 *   `translate:save` does accept an `--approve` flag, but the unattended agent cannot reach it:
 *   `src/adapters/agent/ClaudeCodeAgent.ts:90` denies `Bash(*--approve*)` outright, and a deny rule
 *   beats every allow rule. A human at a terminal can still pass it; that is still a human.
 * - **`either`** — both sides write a byte-identical row and the row cannot say which. Reporting
 *   these as machine activity would overstate the scheduler; reporting them as human activity would
 *   overstate review. Neither is worth a guess, so the count says so.
 *
 * An unrecognised shape is `either` rather than one of the two definite answers, for the same
 * reason: a future producer must not be credited to a side nobody checked.
 *
 * Note what is **not** here at all: `posted`. `x:reconcile`'s retirement writes no lineage row
 * (`RetireTranslation` takes no `LineageStore`), so publication is invisible to this rollup. That
 * is the one thing this command cannot answer.
 */
export type ActivityDriver = "machine" | "either" | "human";

export interface ActivityKind {
  key: string;
  driver: ActivityDriver;
}

/**
 * Every `(stage, status)` shape a producer writes today, in pipeline order — which is the order
 * each day's breakdown prints in, so a row reads left-to-right the way the pipeline runs rather
 * than in whatever order the day's events happened to land.
 *
 * `1차`/`2차` are the team's own names for the two review gates (they appear in this codebase's
 * English comments too — see `ApproveRendering`'s class doc), not a translation of something else.
 */
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  { key: "translated", driver: "either" },
  { key: "approved-1차", driver: "human" },
  { key: "converted", driver: "machine" },
  { key: "rendered", driver: "either" },
  { key: "approved-2차", driver: "human" },
  { key: "forked", driver: "human" },
  { key: "reverted", driver: "human" },
];

const DRIVERS: readonly ActivityDriver[] = ["machine", "either", "human"];

/** One line of the legend, per driver: what the label means, in the terms of this pipeline. */
const DRIVER_NOTES: Record<ActivityDriver, string> = {
  machine: "an unattended run and nothing else — no dashboard route builds SaveConversion.",
  either: "the agent's translate:save/format:save and a reviewer's dashboard edit write the same row.",
  human: "no machine path writes these — the scheduler's agent is denied `--approve` outright.",
};

/** The `(stage, status)` shape of a row, classified. See `ActivityDriver` for where each rule
 *  comes from; the order of the branches is load-bearing (`forked` and `approved` first). */
export function classifyEvent(event: { stage: string; status?: string }): { kind: string; driver: ActivityDriver } {
  const { stage, status } = event;
  if (stage === "forked") return status === "reverted" ? kind("reverted") : kind("forked");
  if (status === "approved") {
    if (stage === "translated") return kind("approved-1차");
    if (stage === "rendered") return kind("approved-2차");
  }
  if (stage === "converted") return kind("converted");
  if (stage === "translated" && status === "translated") return kind("translated");
  if (stage === "rendered" && status === "rendered") return kind("rendered");
  // Nothing writes this today. Named so it is visible, and `either` so it is never miscredited.
  return { kind: status ? `${stage}:${status}` : stage, driver: "either" };
}

function kind(key: string): { kind: string; driver: ActivityDriver } {
  const found = ACTIVITY_KINDS.find((k) => k.key === key);
  if (!found) throw new Error(`activity kind not declared in ACTIVITY_KINDS: ${key}`);
  return { kind: found.key, driver: found.driver };
}

/**
 * `Intl` rather than a `+9h` offset added by hand. Korea has observed a constant UTC+09:00 with no
 * DST since 1988, so the arithmetic would in fact be right for every timestamp this table can hold
 * — but it would be right by a fact about Korea that is nowhere in the code, and it is the kind of
 * fact that gets copied into the next timezone where it is false. `formatToParts` with an explicit
 * numeric field set, rather than a locale that happens to render ISO order: `en-CA` gives
 * `2026-08-07` and `en-US` gives `08/07/2026` for the same options, and neither is a guarantee.
 */
const SEOUL = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function seoulDateOf(at: Date): string {
  const parts: Record<string, string> = {};
  for (const p of SEOUL.formatToParts(at)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * The Asia/Seoul calendar date an ISO instant falls on, or `undefined` if it is not an instant.
 *
 * A UTC rollup is wrong here in both directions, not merely shifted: 08:00 KST files under the
 * *previous* UTC date, so a Korean working day starts on the day before it; and 22:00 KST with
 * 01:00 KST the next morning share a UTC date, so an evening and the small hours after it merge
 * into one. Neither is visible in the output — the numbers just quietly belong to the wrong days.
 */
export function seoulDate(iso: string): string | undefined {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? undefined : seoulDateOf(at);
}

/**
 * `--since <date>` → the Asia/Seoul date the rollup floors on.
 *
 * Validation follows `src/cli/translateSince.ts` (parse with `Date`, refuse what it cannot read,
 * normalise rather than pass through) but **not** its output: that one normalises to a UTC instant
 * because its consumer compares ISO timestamps as strings. Normalising to an instant here would
 * reintroduce the very bug this command exists to avoid — `--since 2026-08-07` parses to
 * `2026-08-07T00:00:00Z`, which is 09:00 KST, so an instant filter would silently drop everything
 * a Korean reviewer did that morning while the header still claimed to cover 2026-08-07.
 *
 * Lives here, next to `seoulDate`, rather than in `src/cli/`: the floor and the bucket key have to
 * be produced by the same rule or the filter cuts on a boundary the table does not have, and
 * putting the two in different directories is how that drifts.
 */
export function parseActivitySince(raw: string | undefined): string | undefined {
  // A `--since` with nothing after it reaches here as undefined; `--since ""` reaches it as "".
  // Both are unset — "" would otherwise fail validation and refuse a command that asked for
  // nothing in particular.
  const value = raw?.trim();
  if (!value) return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--since is not a date this can parse: ${JSON.stringify(raw)}. ` +
        `Use a date such as 2026-08-07, or a full ISO-8601 instant such as 2026-08-07T14:35:24.000Z.`,
    );
  }
  return seoulDateOf(parsed);
}

export interface ActivityTally {
  total: number;
  /** Only the kinds that actually occurred. Absent is zero — `byDriver` is the one that always
   *  carries every key, because a driver reading zero is itself the answer to a question. */
  byKind: Record<string, number>;
  byDriver: Record<ActivityDriver, number>;
}

export interface ActivityDay extends ActivityTally {
  /** `YYYY-MM-DD` in Asia/Seoul. */
  date: string;
}

export interface ActivityRollup {
  /** Ascending by date. Days with no events are absent, not zero-filled: the gaps in this list are
   *  information (the pipeline was idle), and inventing rows for them would bury the days that
   *  matter under a calendar. */
  days: ActivityDay[];
  totals: ActivityTally;
  /** The Seoul date floor that was applied, if any. */
  since?: string;
  /** Entries whose `at` is not a readable instant. Counted and reported rather than dropped: a row
   *  silently missing from a history is the failure mode this whole command is a fix for. */
  undated: number;
}

const emptyTally = (): ActivityTally => ({ total: 0, byKind: {}, byDriver: { machine: 0, either: 0, human: 0 } });

function record(tally: ActivityTally, kind: string, driver: ActivityDriver): void {
  tally.total += 1;
  tally.byKind[kind] = (tally.byKind[kind] ?? 0) + 1;
  tally.byDriver[driver] += 1;
}

/**
 * Groups events into Asia/Seoul days. Input order is irrelevant — the days come back sorted — so a
 * store may return rows in whatever order is cheapest for it.
 */
export function lineageActivity(events: LineageEvent[], options: { since?: string } = {}): ActivityRollup {
  const { since } = options;
  const byDate = new Map<string, ActivityDay>();
  const totals = emptyTally();
  let undated = 0;

  for (const event of events) {
    const date = seoulDate(event.at);
    if (!date) {
      // Counted before the `since` filter on purpose: an entry with no readable timestamp cannot be
      // placed inside or outside the window, and reporting it only on unfiltered runs would hide it
      // from exactly the narrowed runs someone reaches for when a number looks wrong.
      undated += 1;
      continue;
    }
    if (since && date < since) continue; // `YYYY-MM-DD` compares correctly as a string.

    let day = byDate.get(date);
    if (!day) {
      day = { date, ...emptyTally() };
      byDate.set(date, day);
    }
    const { kind, driver } = classifyEvent(event);
    record(day, kind, driver);
    record(totals, kind, driver);
  }

  return {
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals,
    since,
    undated,
  };
}

/** `translated 12 · approved-1차 5 · converted 6` — declared kinds in pipeline order, then anything
 *  undeclared, alphabetically so the tail is at least stable. Zero counts are left out: a day's row
 *  should read as what happened that day, and the legend below carries the full vocabulary. */
function describeKinds(byKind: Record<string, number>): string {
  const declared = ACTIVITY_KINDS.map((k) => k.key);
  const extra = Object.keys(byKind).filter((k) => !declared.includes(k)).sort();
  return [...declared, ...extra]
    .filter((k) => byKind[k])
    .map((k) => `${k} ${byKind[k]}`)
    .join(" · ");
}

const TOTAL_LABEL = "total";

/**
 * The rendered rollup.
 *
 * Two blocks, answering the two halves of the question separately. The table says *when* and
 * *what*; the legend says *who* and names, for each driver, the whole vocabulary of kinds it
 * covers — including the ones that did not occur.
 *
 * That last part is the point rather than a detail. `pnpm status`'s bare `approved 0` was read as
 * "1차 검수 has stalled" when the number simply was not measuring what it was asked, and a legend
 * that omitted an empty `human` line would let this output be misread the same way: the reader
 * could not tell "no one approved anything" from "approvals are not counted here". So every driver
 * prints, with its count, always.
 */
export function formatActivity(rollup: ActivityRollup): string {
  const header = `Lineage activity (Asia/Seoul)${rollup.since ? ` · since ${rollup.since}` : ""}`;
  const out: string[] = [header, ""];

  if (rollup.days.length === 0) {
    out.push(`  no lineage events${rollup.since ? " in this window" : " yet"}`);
  } else {
    const dateW = Math.max(TOTAL_LABEL.length, ...rollup.days.map((d) => d.date.length));
    const numW = String(rollup.totals.total).length;
    const row = (label: string, tally: ActivityTally) =>
      `  ${label.padEnd(dateW)}  ${String(tally.total).padStart(numW)}   ${describeKinds(tally.byKind)}`;
    for (const day of rollup.days) out.push(row(day.date, day));
    out.push(row(TOTAL_LABEL, rollup.totals));
  }

  if (rollup.undated > 0) {
    out.push("", `  ${rollup.undated} entr(y/ies) skipped — unreadable timestamp, so no date to file them under`);
  }

  // Same column shape as the table above and as `formatStatus`: label, count, then the note.
  out.push("");
  const driverW = Math.max(...DRIVERS.map((d) => d.length));
  const driverNumW = String(rollup.totals.total).length;
  for (const driver of DRIVERS) {
    const kinds = ACTIVITY_KINDS.filter((k) => k.driver === driver).map((k) => k.key).join(" · ");
    const count = String(rollup.totals.byDriver[driver]).padStart(driverNumW);
    out.push(`  ${driver.padEnd(driverW)}  ${count}   ${kinds}`);
    out.push(`  ${" ".repeat(driverW + 2 + driverNumW)}   ${DRIVER_NOTES[driver]}`);
  }

  return out.join("\n");
}
