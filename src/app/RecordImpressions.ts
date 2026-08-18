import type { SheetClient } from "../ports/SheetClient";
import type { SourceGateway } from "../ports/SourceGateway";

const DATA_RANGE = "history!A2:I"; // every history data row (header is row 1)

export interface ImpressionFailure {
  postId: string;
  error: string;
}

export interface ImpressionsResult {
  updated: number;
  skipped: number;
  failed: number;
  failures: ImpressionFailure[];
}

/**
 * Fills the reserved impression columns (H, I) of the `history` tab with each published X post's
 * current view count. Reads only what RecordPublish wrote (A–G) and writes only H/I, so the two
 * subsystems share a row while owning disjoint columns.
 */
export class RecordImpressions {
  constructor(
    private readonly sheet: SheetClient,
    private readonly source: Pick<SourceGateway, "fetchByIds">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(opts: { since?: string } = {}): Promise<ImpressionsResult> {
    const rows = await this.sheet.getValues(DATA_RANGE);

    // Capture each row's 1-based sheet row number (index + 2) before filtering, so writes target
    // the right row after the eligible subset is taken.
    const eligible = rows
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => {
        const channel = row[2]; // col C
        const postId = row[3]; // col D
        const publishedAt = row[6] ?? ""; // col G
        if (channel !== "x" || !postId) return false;
        if (opts.since && publishedAt < opts.since) return false;
        return true;
      });

    if (eligible.length === 0) return { updated: 0, skipped: 0, failed: 0, failures: [] };

    const tweets = await this.source.fetchByIds(eligible.map((e) => e.row[3]));
    const viewCountById = new Map<string, number>();
    for (const t of tweets) {
      // Only viewCount is recorded (col H). fetchByIds already returns the whole tweet, so
      // t.metrics also carries likeCount/retweetCount/replyCount/quoteCount/bookmarkCount — if
      // engagement columns are ever added (J/K…), capture them here; the fetch is already paid for.
      const v = t.metrics?.viewCount;
      if (v !== undefined) viewCountById.set(t.id, v);
    }

    let skipped = 0;
    const failures: ImpressionFailure[] = [];
    const stamp = this.now().toISOString();

    /**
     * Collected first, written once. The Sheets API allows 60 write requests per minute per user, so
     * one `updateValues` per row stops fitting the moment a sweep passes about sixty rows: measured
     * against production on 2026-08-19, a 74-row run took an HTTP 429 on the last row after three
     * attempts and reported it as a failed post. `batchUpdateValues` sends the same narrow H:I
     * ranges — nothing here widens what a row write touches — in a single request.
     */
    const updates: { range: string; rows: string[][] }[] = [];
    const postIds: string[] = [];
    for (const { row, rowNumber } of eligible) {
      const postId = row[3];
      const viewCount = viewCountById.get(postId);
      if (viewCount === undefined) {
        // Tweet not returned (deleted/protected) or without a view count — leave H/I as they are.
        skipped += 1;
        continue;
      }
      updates.push({ range: `history!H${rowNumber}:I${rowNumber}`, rows: [[String(viewCount), stamp]] });
      postIds.push(postId);
    }

    if (updates.length === 0) return { updated: 0, skipped, failed: 0, failures: [] };

    /**
     * One request means one outcome: either every row landed or none did. Reporting the whole batch
     * against each post it carried keeps `failures` answering the same question it did per-row —
     * which posts have no impressions recorded — rather than leaving the operator to infer it.
     */
    try {
      await this.sheet.batchUpdateValues(updates);
      return { updated: updates.length, skipped, failed: 0, failures: [] };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const postId of postIds) failures.push({ postId, error });
      return { updated: 0, skipped, failed: updates.length, failures };
    }
  }
}
