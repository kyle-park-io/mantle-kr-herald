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
import type { RecordKolTelegramResult } from "./RecordKolTelegramPosts";
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
 * Distinct deliverables per KOL name, for one month's posts — keyed on the roster's `sheetLabel`,
 * the name the monthly log itself uses to identify a KOL.
 *
 * This is deliberately *not* the contract tab's name for the same KOL: on live data the two
 * disagree (contract `"Enjoy hobby"` vs roster/monthly-log `"Enjoyhobby"`; contract `"Leedogin"`
 * has no roster row at all). Reconciling that mismatch is `compareAgainstContract`'s job, via a
 * normalised join — this function only ever counts by whatever `sheetLabel` the roster carries.
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
 * Loosely folds a KOL name so the contract tab's spelling can be matched against the roster's,
 * without pretending the two are the same string. On live data they disagree only by case and
 * incidental whitespace (`"Enjoy hobby"` vs `"Enjoyhobby"`), never by substance, so this is
 * deliberately narrow: it does not fuzzy-match, transliterate, or strip punctuation. A pair that
 * still disagrees after this is a genuinely different name, not a formatting accident, and is
 * reported as unmatched rather than guessed at.
 */
function normalizeKolName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * One month's actual counts against that month's contract targets. A `count` requirement the
 * actual falls short of is a shortfall; `unlimited` produces nothing; `unreadable` — a deliverable
 * cell the contract parser could not make sense of — goes to `unknownTargets` rather than being
 * silently skipped or silently treated as met.
 *
 * The join between `targets` (keyed on the contract tab's own spelling) and the roster (keyed on
 * `sheetLabel`) is normalised — see `normalizeKolName` — rather than exact, because the two tabs
 * disagree on live data. A contract name that still cannot be resolved to any roster `sheetLabel`
 * after normalising is reported in `unmatchedContractNames`, never folded into `shortfalls` as
 * `actual: 0`: "we don't know if they delivered" and "they delivered nothing" are different
 * findings, and conflating them fabricates a shortfall for a KOL who may have posted plenty under a
 * name this run just couldn't match.
 *
 * `roster` is taken separately from `counts` on purpose, not inferred from which names `counts`
 * happens to carry: `countPostsByKolName` only ever produces an entry for a name with at least one
 * post, so a roster member who is real but posted nothing this month is otherwise indistinguishable
 * from a name with no roster row at all — the first is a genuine shortfall of zero, the second is
 * unmatched, and only the roster itself tells them apart.
 *
 * Pure and total: never throws, never touches a sheet. This is the whole of what Task 6's global
 * constraint ("the comparison is report-only") means in code — nothing here can write anything.
 */
export function compareAgainstContract(
  month: string,
  counts: Map<string, number>,
  targets: DeliverableTarget[],
  roster: KolMapEntry[],
): {
  shortfalls: QuarterReport["shortfalls"];
  unknownTargets: QuarterReport["unknownTargets"];
  unmatchedContractNames: QuarterReport["unmatchedContractNames"];
} {
  const countsByNormalizedName = new Map<string, number>();
  for (const [name, count] of counts) countsByNormalizedName.set(normalizeKolName(name), count);

  const knownNormalizedNames = new Set(
    roster
      .map((r) => r.sheetLabel.trim())
      .filter((label) => label !== "")
      .map(normalizeKolName),
  );

  const shortfalls: QuarterReport["shortfalls"] = [];
  const unknownTargets: QuarterReport["unknownTargets"] = [];
  const unmatchedContractNames: QuarterReport["unmatchedContractNames"] = [];

  for (const target of targets) {
    if (target.month !== month) continue;
    if (target.requirement.kind === "unreadable") {
      unknownTargets.push({ month, kolName: target.kolName, raw: target.requirement.raw });
      continue;
    }
    if (target.requirement.kind === "unlimited") continue;

    const normalized = normalizeKolName(target.kolName);
    if (!knownNormalizedNames.has(normalized)) {
      unmatchedContractNames.push({ month, kolName: target.kolName, required: target.requirement.count });
      continue;
    }
    const actual = countsByNormalizedName.get(normalized) ?? 0;
    if (actual < target.requirement.count) {
      shortfalls.push({ month, kolName: target.kolName, actual, required: target.requirement.count });
    }
  }
  return { shortfalls, unknownTargets, unmatchedContractNames };
}

export interface QuarterReport {
  quarter: string;
  months: {
    month: string;
    written: number;
    unresolved: string[];
    /** The underlying Telegram sweep's own counters for this month — surfaced here rather than
     *  discarded, because a truncated or partly-failed sweep undercounts posts, which becomes a
     *  false shortfall in this very report while the run itself still exits 0. */
    recorded: RecordKolTelegramResult;
  }[];
  shortfalls: { month: string; kolName: string; actual: number; required: number }[];
  unknownTargets: { month: string; kolName: string; raw: string }[];
  /** A contract row whose KOL name could not be matched to any roster `sheetLabel`, even after
   *  normalising — reported instead of silently compared as `actual: 0`. */
  unmatchedContractNames: { month: string; kolName: string; required: number }[];
  /**
   * Set when the contract tab itself could not be read or parsed this run. When this is set,
   * `shortfalls`/`unknownTargets`/`unmatchedContractNames` are empty for a reason that has nothing
   * to do with every KOL meeting their target — callers must check this before reading an empty
   * `shortfalls` as an all-clear.
   */
  contractError: string | undefined;
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

  async run(input: { quarter: string; renderings: MatchCandidate[] }): Promise<QuarterReport> {
    // Validated before any sheet call, same posture as RecordKolTelegramPosts.run: a mis-typed
    // quarter must not half-sweep tabs or file counts against the wrong contract block.
    const months = monthsOfQuarter(input.quarter);
    const year = Number(input.quarter.slice(0, 4));
    const { renderings } = input;

    // `renderings` is required precisely so a caller has to decide this, not inherit it by
    // omission. Mirrors kol-telegram-record.ts's own warning for the same state (that command's
    // candidates come from a live database; this one's come from whatever the caller passed) —
    // without it, a blank itemId/topic/matchScore on a freshly recorded row is indistinguishable
    // from "the matcher looked and found nothing".
    if (renderings.length === 0) {
      console.warn(
        "[kol-quarter] no approved Telegram rendering was supplied to attribute against — every " +
          "newly recorded row's itemId, matchScore and topic will be blank, and a human fills topic " +
          "by hand. That is expected if nothing has been wired up to supply renderings yet; " +
          "unexpected if a real rendering source exists and simply wasn't passed in.",
      );
    }

    const roster = await new LoadKolMap(this.sheet).run();

    // A contract tab this run cannot parse must not block the record+project half below — that half
    // is what actually keeps the workbook current. `targets` is left empty and `contractError` is
    // set instead, so the report can say "I had no targets to compare against" rather than looking
    // like a clean sweep where every KOL happened to meet their target.
    let targets: DeliverableTarget[] = [];
    let contractError: string | undefined;
    try {
      const contractRows = await this.sheet.getValues(`'${contractTabName(input.quarter)}'!A:Z`);
      targets = parseContractDeliverables(contractRows, year);
    } catch (err) {
      contractError = (err as Error).message;
      console.warn(
        `[kol-quarter] could not read this quarter's contract targets: ${contractError} — ` +
          "every KOL's target is unknown this run rather than compared.",
      );
    }

    const months_: QuarterReport["months"] = [];
    const shortfalls: QuarterReport["shortfalls"] = [];
    const unknownTargets: QuarterReport["unknownTargets"] = [];
    const unmatchedContractNames: QuarterReport["unmatchedContractNames"] = [];

    for (const month of months) {
      const recorded = await new RecordKolTelegramPosts(this.sheet, this.gateway).run({
        month,
        map: roster,
        renderings,
      });

      const window = monthWindow(month);
      const rawRows = await this.sheet.getValues(`${TELEGRAM_POSTS_TAB}!A2:Z`);
      const posts = rawRows
        .map(rowToKolTelegramRow)
        .filter((p) => p.postedAt >= window.startISO && p.postedAt < window.endExclusiveISO);

      const projection = await new ProjectMonthlyLog(this.sheet, this.resolveTab).run({ month, roster, posts });
      months_.push({ month, written: projection.written, unresolved: projection.unresolved, recorded });

      const counts = countPostsByKolName(posts, roster);
      const cmp = compareAgainstContract(month, counts, targets, roster);
      shortfalls.push(...cmp.shortfalls);
      unknownTargets.push(...cmp.unknownTargets);
      unmatchedContractNames.push(...cmp.unmatchedContractNames);
    }

    return { quarter: input.quarter, months: months_, shortfalls, unknownTargets, unmatchedContractNames, contractError };
  }
}
