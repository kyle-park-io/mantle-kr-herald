import type { SheetClient } from "../ports/SheetClient";
import type { TelegramChannelGateway } from "../ports/TelegramChannelGateway";
import type { ChannelPost, KolMapEntry } from "../domain/kol/models";
import { KOL_TELEGRAM_HEADER } from "../domain/kol/models";
import { isMantleCandidate } from "../domain/kol/candidacy";
import { sumReactions, formatReactions } from "../domain/kol/reactions";
import { bestMatch } from "../domain/kol/attribution";
import type { MatchCandidate } from "../domain/kol/attribution";
import { monthWindow } from "../domain/metrics/window";

const TAB = "kol-telegram-posts";

// Column positions, derived once from the header — never hardcode a bare index.
const IDX = {
  kolId: KOL_TELEGRAM_HEADER.indexOf("kolId"),
  tgHandle: KOL_TELEGRAM_HEADER.indexOf("tgHandle"),
  postedAt: KOL_TELEGRAM_HEADER.indexOf("postedAt"),
  deliverableLink: KOL_TELEGRAM_HEADER.indexOf("deliverableLink"),
  views: KOL_TELEGRAM_HEADER.indexOf("views"),
  engagements: KOL_TELEGRAM_HEADER.indexOf("engagements"),
  reactionsDetail: KOL_TELEGRAM_HEADER.indexOf("reactionsDetail"),
  itemId: KOL_TELEGRAM_HEADER.indexOf("itemId"),
  topic: KOL_TELEGRAM_HEADER.indexOf("topic"),
  matchScore: KOL_TELEGRAM_HEADER.indexOf("matchScore"),
  pricePerPost: KOL_TELEGRAM_HEADER.indexOf("pricePerPost"),
  fetchedAt: KOL_TELEGRAM_HEADER.indexOf("fetchedAt"),
  confirmed: KOL_TELEGRAM_HEADER.indexOf("confirmed"),
} as const;

/** 0-based column index to its A1 letter, so no column letter is ever written out by hand. */
function colLetter(index: number): string {
  let n = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

const LAST_COL = colLetter(KOL_TELEGRAM_HEADER.length - 1);
const HEADER_RANGE = `${TAB}!A1:${LAST_COL}1`;
const DATA_RANGE = `${TAB}!A2:${LAST_COL}`;

/**
 * The only fields the machine may write on a row that **already exists**, and the whole of the §6
 * invariant "the machine never overwrites a human" expressed as a *mechanism* rather than an
 * outcome.
 *
 * `confirmed` is absent by construction: it is the human's column, so no range this file writes to
 * an existing row may cover it. Copying the old value forward — what this used to do — is not
 * preservation under concurrent editing. A run over 7-13 channels takes minutes against a workbook
 * people are editing, so a human who types `paid` into row 5 at t+30s had it reset to `""` when row
 * 5 was refreshed at t+90s, and the next run re-proposed the row. A `reject` became eligible again.
 *
 * `pricePerPost` is here only for the blank-only backfill in `upsert`; on a row that already carries
 * a price its value never differs, so it never lands inside a written range either.
 *
 * The identity columns (`kolId`..`deliverableLink`) are absent too — they are machine-owned but
 * immutable, so re-writing them would be pure risk for no gain.
 */
const REFRESHABLE_FIELDS = [
  "views",
  "engagements",
  "reactionsDetail",
  "itemId",
  "topic",
  "matchScore",
  "pricePerPost",
  "fetchedAt",
] as const satisfies readonly (keyof typeof IDX)[];

/** Kept well under any request-size limit; each chunk is still one write against the quota. */
const MAX_RANGES_PER_BATCH = 200;
const MAX_ROWS_PER_APPEND = 500;

/** Pad a sheet row to full header width; the Sheets API omits trailing empty cells. */
function padRow(row: string[]): string[] {
  if (row.length >= KOL_TELEGRAM_HEADER.length) return [...row];
  return [...row, ...new Array(KOL_TELEGRAM_HEADER.length - row.length).fill("")];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface RecordKolTelegramInput {
  month: string; // YYYY-MM
  map: KolMapEntry[];
  renderings: MatchCandidate[]; // approved Telegram-channel copy
}

export interface RecordKolTelegramResult {
  created: number;
  refreshed: number;
  channelsSwept: number;
  channelsFailed: number;
  channelsTruncated: number;
}

interface PendingWrites {
  updates: { range: string; rows: string[][] }[];
  appends: string[][];
}

export class RecordKolTelegramPosts {
  constructor(
    private readonly sheet: SheetClient,
    private readonly gateway: TelegramChannelGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: RecordKolTelegramInput): Promise<RecordKolTelegramResult> {
    // Validate before any sheet call so a typo'd month cannot half-write the tab.
    const window = monthWindow(input.month);

    await this.sheet.ensureTab(TAB);
    const header = await this.sheet.getValues(HEADER_RANGE);
    if (header.length === 0 || (header[0] ?? []).length === 0) {
      await this.sheet.updateValues(HEADER_RANGE, [KOL_TELEGRAM_HEADER]);
    }

    // Read the data range exactly once per run, then work off an in-memory index.
    // Re-reading per post (as RecordMetrics does per account) is fine for eight
    // accounts but not for hundreds of posts.
    // Padded to full header width: the real Sheets API drops trailing empty cells
    // (e.g. a not-yet-confirmed row's blank `confirmed` in the last column), and a
    // short row copied straight through would risk a ragged write downstream.
    const rows: string[][] = (await this.sheet.getValues(DATA_RANGE)).map((r) => padRow(r));
    const linkIndex = this.indexByLink(rows);
    // Links appended during *this* run. They are deliberately absent from `linkIndex`: their sheet
    // row does not exist yet, so an update addressed to a row number would land somewhere else.
    const appendedThisRun = new Set<string>();

    // Every write is buffered and flushed once, below. One request per row could not fit inside
    // Sheets' 60-writes-per-minute-per-user quota: ~7% of posts are candidates and the live dry-run
    // measured 236 posts/month for one channel, so ~16 rows/channel — 112 writes over seven
    // channels, ~200 over thirteen. The previous write-per-post took a 429 partway through, and
    // because the throw was caught by the per-channel handler it abandoned the rest of that
    // channel's posts, reported the channel as failed, and left a partial write behind.
    const pending: PendingWrites = { updates: [], appends: [] };

    let created = 0;
    let refreshed = 0;
    let channelsSwept = 0;
    let channelsFailed = 0;
    let channelsTruncated = 0;

    for (const entry of input.map) {
      if (!entry.active) continue;
      channelsSwept += 1;
      try {
        const { posts, truncated } = await this.gateway.fetchPostsInWindow(
          entry.tgHandle,
          window.startISO,
          window.endExclusiveISO,
        );
        // A truncated sweep still produced real rows worth keeping, so this warns and continues
        // rather than throwing — the same posture as a channel failure, just not one.
        if (truncated) {
          console.warn(`[kol-telegram] ${entry.tgHandle} truncated: hit the page cap before covering the month`);
          channelsTruncated += 1;
        }
        for (const post of posts) {
          if (!isMantleCandidate(post.text)) continue;
          const outcome = this.upsert(entry, post, input.renderings, rows, linkIndex, appendedThisRun, pending);
          if (outcome === "created") created += 1;
          else if (outcome === "refreshed") refreshed += 1;
          // "reject" and "duplicate" count toward neither.
        }
      } catch (err) {
        // Covers a dead channel too: `ChannelUnreadableError` is thrown when the preview page held
        // no message blocks at all, which t.me serves as a HTTP 200 rather than an error. Counting
        // it here is what keeps the summary honest — a channel that could not be read must never be
        // reported as swept clean.
        console.warn(`[kol-telegram] ${entry.tgHandle} failed: ${(err as Error).message}`);
        channelsFailed += 1;
      }
    }

    await this.flush(pending);

    return { created, refreshed, channelsSwept, channelsFailed, channelsTruncated };
  }

  /**
   * `deliverableLink` to row position, keeping the **first** row for a repeated link.
   *
   * A pre-existing duplicate used to keep the *last* row, which froze the earlier one at whatever
   * numbers it was created with while it still looked like a distinct post — two rows for one
   * deliverable is a double payment. Keeping the first makes the maintained row stable across runs,
   * and the warning makes the tab self-auditing.
   */
  private indexByLink(rows: string[][]): Map<string, number> {
    const linkIndex = new Map<string, number>();
    rows.forEach((row, i) => {
      const link = row[IDX.deliverableLink];
      if (!link) return;
      const first = linkIndex.get(link);
      if (first !== undefined) {
        console.warn(
          `[kol-telegram] duplicate deliverableLink in '${TAB}': ${link} is on rows ${first + 2} and ${i + 2}. ` +
            `A Telegram permalink is one deliverable, so two rows bill it twice — row ${first + 2} is the one ` +
            `this run keeps up to date; check which row carries the human's verdict and delete the other.`,
        );
        return;
      }
      linkIndex.set(link, i);
    });
    return linkIndex;
  }

  private upsert(
    entry: KolMapEntry,
    post: ChannelPost,
    renderings: MatchCandidate[],
    rows: string[][],
    linkIndex: Map<string, number>,
    appendedThisRun: Set<string>,
    pending: PendingWrites,
  ): "created" | "refreshed" | "reject" | "duplicate" {
    const link = post.url;

    if (appendedThisRun.has(link)) {
      // Should be unreachable: the gateway de-duplicates by messageId and two channels cannot share
      // a permalink. Guarded anyway because the row is not on the sheet yet, so treating it as an
      // existing row would address an update at a row number that holds something else.
      console.warn(`[kol-telegram] ${link} was produced twice in one run; the second occurrence was ignored`);
      return "duplicate";
    }

    const idx = linkIndex.get(link);
    if (idx !== undefined) {
      const existing = rows[idx];
      if (existing[IDX.confirmed] === "reject") return "reject";

      const updated = [...existing];
      updated[IDX.views] = String(post.views);
      updated[IDX.engagements] = String(sumReactions(post.reactions));
      updated[IDX.reactionsDetail] = formatReactions(post.reactions);
      updated[IDX.fetchedAt] = this.now().toISOString();
      this.applyAttribution(updated, existing, post, renderings);
      // Blank-only backfill, same rule as itemId/topic/matchScore: a price that never got written —
      // because `kol-map`'s cell was unreadable at the time — can still be repaired by fixing that
      // cell and re-running. A row that already carries a number is left alone; it may be a human's.
      if (existing[IDX.pricePerPost] === "" && entry.pricePerPost > 0) {
        updated[IDX.pricePerPost] = String(entry.pricePerPost);
      }
      // topic is carried through unchanged unless it is still blank — then it may inherit, same as
      // a brand-new row (e.g. a July-backfill row whose itemId only gets filled once real copy
      // exists to match against).
      this.applyInheritedTopic(updated, rows);

      rows[idx] = updated;
      pending.updates.push(...this.changedRanges(idx + 2, existing, updated));
      return "refreshed";
    }

    const match = bestMatch(post.text, renderings);
    const row = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    row[IDX.kolId] = entry.kolId;
    // The canonical casing the page reported, not the casing a human typed into `kol-map`, so this
    // column and the permalink in `deliverableLink` always agree.
    row[IDX.tgHandle] = post.handle;
    row[IDX.postedAt] = post.postedAt;
    row[IDX.deliverableLink] = link;
    row[IDX.views] = String(post.views);
    row[IDX.engagements] = String(sumReactions(post.reactions));
    row[IDX.reactionsDetail] = formatReactions(post.reactions);
    row[IDX.itemId] = match?.itemId ?? "";
    row[IDX.matchScore] = match ? match.score.toFixed(2) : "";
    // Left blank rather than "0" when the rate is unknown, so the blank-only backfill above can
    // repair the row on a later run once `kol-map`'s cell is fixed. A written "0" would be sticky.
    row[IDX.pricePerPost] = entry.pricePerPost > 0 ? String(entry.pricePerPost) : "";
    row[IDX.fetchedAt] = this.now().toISOString();
    row[IDX.confirmed] = "";
    this.applyInheritedTopic(row, rows);

    // A new row is appended at full width: it does not exist yet, so there is no human value on it
    // to protect.
    pending.appends.push(row);
    rows.push(row);
    appendedThisRun.add(link);
    return "created";
  }

  /**
   * Fill `itemId`/`matchScore` while blank, and keep the pair coherent.
   *
   * Two failures this replaces. Gating on `itemId === ""` alone **cleared** a score that was already
   * in the sheet whenever nothing matched this time round — the rule is fill-while-blank, not
   * clear-when-blank. And once a human corrected `itemId`, the machine's old score stayed put and
   * now described a different item, reading as evidence for an attribution it never scored.
   */
  private applyAttribution(
    updated: string[],
    existing: string[],
    post: ChannelPost,
    renderings: MatchCandidate[],
  ): void {
    const match = bestMatch(post.text, renderings);
    const currentItemId = existing[IDX.itemId];
    const currentScore = existing[IDX.matchScore];

    if (currentItemId === "") {
      // Nothing attributed yet. Fill both when there is a match; when there is not, leave whatever
      // score is already there rather than blanking it.
      if (match) {
        updated[IDX.itemId] = match.itemId;
        updated[IDX.matchScore] = match.score.toFixed(2);
      }
      return;
    }

    // An itemId is present — a human's correction, or the machine's own earlier guess. Never
    // re-guess it.
    if (match === undefined) return; // no opinion this run; a score already there is left alone
    if (match.itemId === currentItemId) {
      if (currentScore === "") updated[IDX.matchScore] = match.score.toFixed(2);
      return;
    }
    // The machine matched a *different* item, so the stored score was scored against something else
    // and is not evidence for the id on this row. Clear it rather than let a stale number stand next
    // to a corrected id. Only ever on a real disagreement: when there is simply nothing to match
    // against — every run before the first approved rendering existed — clearing would destroy a
    // reading rather than correct one.
    if (currentScore !== "") updated[IDX.matchScore] = "";
  }

  /**
   * The narrow A1 ranges covering only the cells that actually changed, grouped into maximal
   * contiguous runs so each is one `ValueRange` in the batch.
   *
   * This is the mechanism that makes the §6 invariant hold under concurrent editing: a column the
   * machine did not change is not inside any range it writes. The layout cooperates — `E:G` is the
   * measurements, `H:J` the attribution, `L` is `fetchedAt` — so the common measurements-only
   * refresh writes `E:G` and `L` and cannot reach `K` (`pricePerPost`) or `M` (`confirmed`), which
   * sit outside both runs. When nothing changed at all this returns `[]` and no write is issued.
   */
  private changedRanges(
    rowNumber: number,
    existing: string[],
    updated: string[],
  ): { range: string; rows: string[][] }[] {
    const changed = REFRESHABLE_FIELDS.map((field) => IDX[field])
      .filter((i) => updated[i] !== existing[i])
      .sort((a, b) => a - b);

    const runs: [number, number][] = [];
    for (const i of changed) {
      const last = runs[runs.length - 1];
      if (last && i === last[1] + 1) last[1] = i;
      else runs.push([i, i]);
    }

    return runs.map(([first, last]) => ({
      range: `${TAB}!${colLetter(first)}${rowNumber}:${colLetter(last)}${rowNumber}`,
      rows: [updated.slice(first, last + 1)],
    }));
  }

  /**
   * Fill `row`'s topic from a sibling row that already carries the same itemId and a non-empty
   * topic. A no-op unless the row has an itemId and no topic of its own — never overwrites a topic a
   * human already typed, on a new row or an existing one.
   *
   * A `reject` row is never a source. A human often rejects a row precisely *because* the
   * attribution was wrong, and since a topic is never overwritten once set, seeding from a rejected
   * row would plant that wrong label on every later row sharing the itemId, permanently.
   */
  private applyInheritedTopic(row: string[], rows: string[][]): void {
    if (row[IDX.itemId] === "" || row[IDX.topic] !== "") return;
    for (const r of rows) {
      if (r[IDX.confirmed] === "reject") continue;
      if (r[IDX.itemId] === row[IDX.itemId] && r[IDX.topic] !== "") {
        row[IDX.topic] = r[IDX.topic];
        return;
      }
    }
  }

  /**
   * One request per chunk instead of one per row. A first run over ~200 posts becomes a single
   * append call rather than ~200; a refresh run becomes one or two `values:batchUpdate` calls rather
   * than one PUT per row.
   *
   * Batching the appends is safe because the in-memory `rows`/`linkIndex` already de-duplicate
   * within a run and two channels cannot share a permalink, so nothing here depends on a previous
   * append having reached the sheet.
   */
  private async flush(pending: PendingWrites): Promise<void> {
    for (const part of chunk(pending.updates, MAX_RANGES_PER_BATCH)) {
      await this.sheet.batchUpdateValues(part);
    }
    for (const part of chunk(pending.appends, MAX_ROWS_PER_APPEND)) {
      await this.sheet.appendValues(DATA_RANGE, part);
    }
  }
}
