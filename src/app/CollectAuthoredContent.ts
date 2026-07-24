import { assembleThreads } from "../domain/threadAssembler";
import type { ArticleBlock, CollectedThread, SourceTweet } from "../domain/models";
import { applyThreadLimit } from "../domain/threadLimit";
import { computeCoverage, type CollectionRun } from "../domain/coverage";
import type { SourceGateway } from "../ports/SourceGateway";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { CollectionRunLedger } from "../ports/CollectionRunLedger";
import type { WatermarkStore } from "../shared/store/WatermarkStore";
import { systemClock, type Clock } from "../ports/Clock";

export interface CollectOptions {
  since?: string;
  limit?: number;
}

export interface CollectResult {
  fetchedCount: number;
  threadCount: number;
  run: CollectionRun;
}

export class CollectAuthoredContent {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly watermark: WatermarkStore,
    private readonly ledger: CollectionRunLedger,
    private readonly now: Clock = systemClock,
  ) {}

  async run(userName: string, opts: CollectOptions = {}): Promise<CollectResult> {
    const adhoc = opts.since !== undefined || opts.limit !== undefined;
    const floor = opts.since ?? (await this.watermark.get(userName));

    const fetched: SourceTweet[] = [];
    const pages = this.source.fetchAuthoredTweets(userName, floor);
    let step = await pages.next();
    while (!step.done) {
      fetched.push(step.value);
      step = await pages.next();
    }
    const paginationExhausted = step.value;

    await this.gapFillMissingRoots(fetched, userName);
    await this.fillArticleBodies(fetched, await this.repo.loadAll());

    const assembled = assembleThreads(fetched);
    const { kept, truncated: truncatedByLimit } = applyThreadLimit(assembled, opts.limit);
    const truncated = truncatedByLimit || paginationExhausted;

    const ranAt = this.now();
    const collected: CollectedThread[] = kept.map((thread) => ({
      rootId: thread.rootId,
      tweets: thread.tweets,
      status: "active",
      firstSeenAt: ranAt,
    }));
    await this.repo.upsert(collected);

    const requested = { since: floor ?? null, until: ranAt };
    const coverage = computeCoverage(kept, requested, truncated);
    const run: CollectionRun = {
      target: userName,
      ranAt,
      requested,
      covered: coverage.covered,
      threadCount: kept.length,
      tweetCount: coverage.tweetCount,
      truncated,
      gap: coverage.gap,
    };
    await this.ledger.record(run);

    if (!adhoc) {
      const maxCreatedAt = this.maxCreatedAt(fetched);
      if (maxCreatedAt && (!floor || maxCreatedAt > floor)) {
        await this.watermark.set(userName, maxCreatedAt);
      }
    }

    return { fetchedCount: fetched.length, threadCount: kept.length, run };
  }

  /** Pull earlier thread parts (via thread_context) for threads whose root is absent. */
  private async gapFillMissingRoots(fetched: SourceTweet[], userName: string): Promise<void> {
    const presentIds = new Set(fetched.map((t) => t.id));
    const missingRoots = new Set<string>();
    for (const t of fetched) {
      if (t.conversationId !== t.id && !presentIds.has(t.conversationId)) {
        missingRoots.add(t.conversationId);
      }
    }
    for (const rootId of missingRoots) {
      const threadTweets = await this.source.fetchThread(rootId);
      for (const t of threadTweets) {
        if (t.authorUserName === userName && !presentIds.has(t.id)) {
          fetched.push(t);
          presentIds.add(t.id);
        }
      }
    }
  }

  /**
   * Fetch each X Article's body. The search response marks a tweet as an article and gives its
   * title and a truncated preview, but the body needs one call per article — without it the
   * tweet's own `text` is a bare t.co link and the whole article is lost.
   *
   * Runs after gap-filling, because a root pulled in by `gapFillMissingRoots` can itself be an
   * article. A failure is per-tweet: the article keeps its title and loses its body rather than
   * aborting the collect, mirroring the gateway's `normalizeOrSkip`.
   *
   * `stored` seeds a skip-list of articles whose body is already in the collection repository, so
   * an already-fetched article is never re-fetched. This is not just an efficiency saving (one
   * fewer API call per article on every `--since` backfill): re-fetching on every run risked a
   * transient failure or an empty response silently overwriting a good stored body with nothing —
   * `LocalJsonStore.mergeTweets` now guards against that too, but there is no reason to court it.
   */
  private async fillArticleBodies(tweets: SourceTweet[], stored: CollectedThread[]): Promise<void> {
    const storedBlocks = new Map<string, ArticleBlock[]>();
    for (const thread of stored) {
      for (const t of thread.tweets) {
        if (t.article?.blocks?.length) storedBlocks.set(t.id, t.article.blocks);
      }
    }
    for (const t of tweets) {
      if (!t.article || t.article.blocks?.length) continue;
      const existingBlocks = storedBlocks.get(t.id);
      if (existingBlocks) {
        t.article = { ...t.article, blocks: existingBlocks };
        continue;
      }
      try {
        const blocks = await this.source.fetchArticle(t.id);
        if (blocks.length === 0) {
          console.warn(`[collect] article ${t.id} returned no content blocks — keeping link only`);
          continue;
        }
        t.article = { ...t.article, blocks };
      } catch (err) {
        console.warn(
          `[collect] article body fetch failed for ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private maxCreatedAt(tweets: SourceTweet[]): string | undefined {
    let max: string | undefined;
    for (const t of tweets) {
      if (!max || t.createdAt > max) max = t.createdAt;
    }
    return max;
  }
}
