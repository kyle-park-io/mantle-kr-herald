import type { SheetClient } from "../ports/SheetClient";
import type { TelegramChannelGateway } from "../ports/TelegramChannelGateway";
import type { KolMapEntry, KolTelegramRow } from "../domain/kol/models";
import { KOL_TELEGRAM_HEADER } from "../domain/kol/models";
import type { MatchCandidate } from "../domain/kol/attribution";
import { parseContractDeliverables } from "../domain/kol/contractDeliverables";
import type { DeliverableTarget } from "../domain/kol/contractDeliverables";
import { monthWindow } from "../domain/metrics/window";
import { LoadKolMap } from "./LoadKolMap";
import { RecordKolTelegramPosts } from "./RecordKolTelegramPosts";
import { ProjectMonthlyLog } from "./ProjectMonthlyLog";

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

const MONTH_ABBREV = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * `"2026-07"` → `"Jul."` — the live workbook's monthly tabs are named by three-letter English
 * abbreviation plus a trailing dot (`Jul.`, `Aug.`, `Sep.`), not by the month number or full name.
 */
export function tabForMonth(month: string): string {
  const m = /^\d{4}-(\d{2})$/.exec(month.trim());
  const index = m ? Number(m[1]) - 1 : -1;
  if (!m || index < 0 || index > 11) {
    throw new Error(`not a month: ${JSON.stringify(month)} — expected e.g. "2026-07"`);
  }
  return `${MONTH_ABBREV[index]}.`;
}

/**
 * The quarter's contract tab, e.g. `" Q3 KOL 계약 리스트"` for `"2026-Q3"`. The leading space is
 * part of the real tab name in the live workbook, not a formatting accident — it must survive into
 * the quoted A1 range unchanged or the read 404s.
 */
function contractTabName(quarter: string): string {
  const q = QUARTER.exec(quarter.trim())![2]; // quarter is already validated by monthsOfQuarter
  return ` Q${q} KOL 계약 리스트`;
}

const TELEGRAM_POSTS_TAB = "kol-telegram-posts"; // mirrors RecordKolTelegramPosts's own (private) TAB constant

// Column positions, derived once from the header — same rule `RecordKolTelegramPosts` follows, so a
// reorder of `KOL_TELEGRAM_HEADER` is the only place this has to change.
const IDX = Object.fromEntries(
  KOL_TELEGRAM_HEADER.map((field, i) => [field, i]),
) as Record<keyof KolTelegramRow, number>;

function rowToKolTelegramRow(row: string[]): KolTelegramRow {
  const cell = (field: keyof KolTelegramRow) => (row[IDX[field]] ?? "").trim();
  return {
    kolId: cell("kolId"),
    tgHandle: cell("tgHandle"),
    postedAt: cell("postedAt"),
    deliverableLink: cell("deliverableLink"),
    views: Number(cell("views")) || 0,
    engagements: Number(cell("engagements")) || 0,
    reactionsDetail: cell("reactionsDetail"),
    itemId: cell("itemId"),
    topic: cell("topic"),
    matchScore: cell("matchScore"),
    pricePerPost: cell("pricePerPost"),
    fetchedAt: cell("fetchedAt"),
    confirmed: cell("confirmed"),
  };
}

/**
 * Distinct deliverables per KOL name, for one month's posts — keyed on `sheetLabel`, the name the
 * contract tab and the monthly log both use to identify a KOL (the contract tab carries no
 * `kolId` at all).
 *
 * Counts distinct `deliverableLink`s rather than `posts.length`, matching what
 * `ProjectMonthlyLog.written` itself counts: two posts sharing a link are one deliverable, one log
 * row, and must be one toward the contract too.
 *
 * A post whose KOL has no `sheetLabel` is skipped here exactly as `ProjectMonthlyLog` skips it (and
 * reports it in `unresolved`) — there is no name to key a count under.
 */
export function countPostsByKolName(posts: KolTelegramRow[], roster: KolMapEntry[]): Map<string, number> {
  const rosterByKolId = new Map(roster.map((r) => [r.kolId, r]));
  const linksByName = new Map<string, Set<string>>();
  for (const post of posts) {
    const entry = rosterByKolId.get(post.kolId);
    const name = entry?.sheetLabel.trim();
    if (!name) continue;
    const links = linksByName.get(name) ?? new Set<string>();
    links.add(post.deliverableLink);
    linksByName.set(name, links);
  }
  const out = new Map<string, number>();
  for (const [name, links] of linksByName) out.set(name, links.size);
  return out;
}

/**
 * One month's actual counts against that month's contract targets. A `count` requirement the
 * actual falls short of is a shortfall; `unlimited` produces nothing; `unreadable` — a deliverable
 * cell the contract parser could not make sense of — goes to `unknownTargets` rather than being
 * silently skipped or silently treated as met.
 *
 * Pure and total: never throws, never touches a sheet. This is the whole of what Task 6's global
 * constraint ("the comparison is report-only") means in code — nothing here can write anything.
 */
export function compareAgainstContract(
  month: string,
  counts: Map<string, number>,
  targets: DeliverableTarget[],
): { shortfalls: QuarterReport["shortfalls"]; unknownTargets: QuarterReport["unknownTargets"] } {
  const shortfalls: QuarterReport["shortfalls"] = [];
  const unknownTargets: QuarterReport["unknownTargets"] = [];
  for (const target of targets) {
    if (target.month !== month) continue;
    if (target.requirement.kind === "unreadable") {
      unknownTargets.push({ month, kolName: target.kolName, raw: target.requirement.raw });
      continue;
    }
    if (target.requirement.kind === "unlimited") continue;
    const actual = counts.get(target.kolName) ?? 0;
    if (actual < target.requirement.count) {
      shortfalls.push({ month, kolName: target.kolName, actual, required: target.requirement.count });
    }
  }
  return { shortfalls, unknownTargets };
}

export interface QuarterReport {
  quarter: string;
  months: { month: string; written: number; unresolved: string[] }[];
  shortfalls: { month: string; kolName: string; actual: number; required: number }[];
  unknownTargets: { month: string; kolName: string; raw: string }[];
}

/**
 * Sweeps every month of a quarter and reports each KOL's actual post count against their contract.
 *
 * Every run covers the whole quarter, not just the current week: `RecordKolTelegramPosts` already
 * re-fetches each channel's *entire* month window on every call (see its own `fetchPostsInWindow`
 * window, always `[monthStart, monthEndExclusive)`), so a month already swept earlier in the
 * quarter is simply re-verified, never left stale. That is what makes a weekly timer over this
 * class idempotent: a KOL who posts late in the month is caught on the next run instead of being
 * undercounted forever by a run that only looked at "since last time".
 */
export class SweepKolQuarter {
  constructor(
    private readonly sheet: SheetClient,
    private readonly gateway: TelegramChannelGateway,
    private readonly resolveTab: (month: string) => string = tabForMonth,
  ) {}

  async run(input: { quarter: string; renderings?: MatchCandidate[] }): Promise<QuarterReport> {
    // Validated before any sheet call, same posture as RecordKolTelegramPosts.run: a mis-typed
    // quarter must not half-sweep tabs or file counts against the wrong contract block.
    const months = monthsOfQuarter(input.quarter);
    const year = Number(input.quarter.slice(0, 4));
    const renderings = input.renderings ?? [];

    const roster = await new LoadKolMap(this.sheet).run();

    // A contract tab this run cannot parse must not block the record+project half below — that half
    // is what actually keeps the workbook current. Left as `[]`, every month's comparison then
    // degrades to "no shortfalls, no unknown targets" instead of throwing, and the cause is logged
    // once here rather than swallowed.
    let targets: DeliverableTarget[] = [];
    try {
      const contractRows = await this.sheet.getValues(`'${contractTabName(input.quarter)}'!A:Z`);
      targets = parseContractDeliverables(contractRows, year);
    } catch (err) {
      console.warn(
        `[kol-quarter] could not read this quarter's contract targets: ${(err as Error).message} — ` +
          "every KOL's target is unknown this run rather than compared.",
      );
    }

    const months_: QuarterReport["months"] = [];
    const shortfalls: QuarterReport["shortfalls"] = [];
    const unknownTargets: QuarterReport["unknownTargets"] = [];

    for (const month of months) {
      await new RecordKolTelegramPosts(this.sheet, this.gateway).run({ month, map: roster, renderings });

      const window = monthWindow(month);
      const rawRows = await this.sheet.getValues(`${TELEGRAM_POSTS_TAB}!A2:Z`);
      const posts = rawRows
        .map(rowToKolTelegramRow)
        .filter((p) => p.postedAt >= window.startISO && p.postedAt < window.endExclusiveISO);

      const projection = await new ProjectMonthlyLog(this.sheet, this.resolveTab).run({ month, roster, posts });
      months_.push({ month, written: projection.written, unresolved: projection.unresolved });

      const counts = countPostsByKolName(posts, roster);
      const cmp = compareAgainstContract(month, counts, targets);
      shortfalls.push(...cmp.shortfalls);
      unknownTargets.push(...cmp.unknownTargets);
    }

    return { quarter: input.quarter, months: months_, shortfalls, unknownTargets };
  }
}
