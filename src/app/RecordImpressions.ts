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

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failures: ImpressionFailure[] = [];
    const stamp = this.now().toISOString();

    for (const { row, rowNumber } of eligible) {
      const postId = row[3];
      const viewCount = viewCountById.get(postId);
      if (viewCount === undefined) {
        // Tweet not returned (deleted/protected) or without a view count — leave H/I as they are.
        skipped += 1;
        continue;
      }
      try {
        await this.sheet.updateValues(`history!H${rowNumber}:I${rowNumber}`, [[String(viewCount), stamp]]);
        updated += 1;
      } catch (err) {
        failed += 1;
        failures.push({ postId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { updated, skipped, failed, failures };
  }
}
