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
const HEADER_RANGE = `${TAB}!A1:M1`;
const DATA_RANGE = `${TAB}!A2:M`;

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

/** Pad a sheet row to full header width; the Sheets API omits trailing empty cells. */
function padRow(row: string[]): string[] {
  if (row.length >= KOL_TELEGRAM_HEADER.length) return [...row];
  return [...row, ...new Array(KOL_TELEGRAM_HEADER.length - row.length).fill("")];
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
    const linkIndex = new Map<string, number>();
    rows.forEach((r, i) => {
      const link = r[IDX.deliverableLink];
      if (link) linkIndex.set(link, i);
    });

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
          const outcome = await this.upsert(entry, post, input.renderings, rows, linkIndex);
          if (outcome === "created") created += 1;
          else if (outcome === "refreshed") refreshed += 1;
          // A "reject" outcome counts toward neither.
        }
      } catch (err) {
        console.warn(`[kol-telegram] ${entry.tgHandle} failed: ${(err as Error).message}`);
        channelsFailed += 1;
      }
    }

    return { created, refreshed, channelsSwept, channelsFailed, channelsTruncated };
  }

  private async upsert(
    entry: KolMapEntry,
    post: ChannelPost,
    renderings: MatchCandidate[],
    rows: string[][],
    linkIndex: Map<string, number>,
  ): Promise<"created" | "refreshed" | "reject"> {
    const link = post.url;
    const idx = linkIndex.get(link);

    if (idx !== undefined) {
      const existing = rows[idx];
      if (existing[IDX.confirmed] === "reject") return "reject";

      const updated = [...existing];
      updated[IDX.views] = String(post.views);
      updated[IDX.engagements] = String(sumReactions(post.reactions));
      updated[IDX.reactionsDetail] = formatReactions(post.reactions);
      updated[IDX.fetchedAt] = this.now().toISOString();
      // A human who corrected an attribution must not have it re-guessed.
      if (existing[IDX.itemId] === "") {
        const match = bestMatch(post.text, renderings);
        updated[IDX.itemId] = match?.itemId ?? "";
        updated[IDX.matchScore] = match ? match.score.toFixed(2) : "";
      }
      // confirmed is carried through unchanged (already copied above). topic is
      // carried through too, unless it's still blank — then it may inherit,
      // same as a brand-new row (e.g. a July-backfill row whose itemId only
      // gets filled once real copy exists to match against).
      this.applyInheritedTopic(updated, rows);

      rows[idx] = updated;
      const rowNumber = idx + 2; // data starts at sheet row 2
      await this.sheet.updateValues(`${TAB}!A${rowNumber}:M${rowNumber}`, [updated]);
      return "refreshed";
    }

    const match = bestMatch(post.text, renderings);
    const itemId = match?.itemId ?? "";
    const matchScore = match ? match.score.toFixed(2) : "";

    const row = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    row[IDX.kolId] = entry.kolId;
    row[IDX.tgHandle] = entry.tgHandle;
    row[IDX.postedAt] = post.postedAt;
    row[IDX.deliverableLink] = link;
    row[IDX.views] = String(post.views);
    row[IDX.engagements] = String(sumReactions(post.reactions));
    row[IDX.reactionsDetail] = formatReactions(post.reactions);
    row[IDX.itemId] = itemId;
    row[IDX.matchScore] = matchScore;
    row[IDX.pricePerPost] = String(entry.pricePerPost);
    row[IDX.fetchedAt] = this.now().toISOString();
    row[IDX.confirmed] = "";
    this.applyInheritedTopic(row, rows);

    await this.sheet.appendValues(DATA_RANGE, [row]);
    rows.push(row);
    linkIndex.set(link, rows.length - 1);
    return "created";
  }

  /**
   * Fill `row`'s topic from a sibling row that already carries the same
   * itemId and a non-empty topic. A no-op unless the row has an itemId and
   * no topic of its own — never overwrites a topic a human already typed,
   * on a new row or an existing one.
   */
  private applyInheritedTopic(row: string[], rows: string[][]): void {
    if (row[IDX.itemId] === "" || row[IDX.topic] !== "") return;
    for (const r of rows) {
      if (r[IDX.itemId] === row[IDX.itemId] && r[IDX.topic] !== "") {
        row[IDX.topic] = r[IDX.topic];
        return;
      }
    }
  }
}
