import type { ArticleBlock, SourceTweet, UserProfile } from "../../domain/models";
import type { SourceGateway } from "../../ports/SourceGateway";
import type { IHttpClient } from "../../shared/http/IHttpClient";
import { normalizeTweet, parseArticleContents, parseTweetList, parseUserProfile } from "./schemas";

/**
 * Safety backstop so a non-terminating cursor or a full-history/large-thread crawl can never loop
 * forever (20 tweets/page → up to ~1000 tweets at the default). This is also the cap that produces
 * a coverage GAP (src/domain/coverage.ts) when `fetchAuthoredTweets` exhausts it with older tweets
 * still unfetched (src/app/WatchTick.ts's header comment has the full chain).
 *
 * Exported because `src/cli/tm-measure.ts` reports a volume estimate *against this cap* — it had
 * its own copy of the number, which is the kind of duplicate that misdescribes reality the first
 * time one of the two moves.
 */
export const DEFAULT_MAX_PAGES = 50;

export type TwitterApiSourceGatewayOptions = {
  /**
   * Page cap for `fetchAuthoredTweets`/`fetchThread`. Omitted means `DEFAULT_MAX_PAGES`, which is
   * what every command except a GAP backfill gets.
   *
   * Injected rather than read from `process.env` here, and that is the point: a constructor that
   * read `HERALD_COLLECT_MAX_PAGES` itself handed the override to all six entry points that build
   * this gateway, when the variable is documented for one of them. The CLI reads the environment
   * (`src/cli/collectMaxPages.ts` validates it); this class just uses the number it is given —
   * the same layering `WatchTick`/`src/cli/watchBatch.ts` already follow for `HERALD_WATCH_BATCH`.
   */
  maxPages?: number;
};

/**
 * The most ids `/twitter/tweets` accepts in one request — the endpoint's own documented cap, quoted
 * back in its 400 message. Exported so a caller that chunks for its own reasons can stay at or
 * under it rather than guessing.
 */
export const MAX_TWEET_IDS_PER_REQUEST = 50;

export class TwitterApiSourceGateway implements SourceGateway {
  private readonly maxPages: number;

  constructor(private readonly client: IHttpClient, options: TwitterApiSourceGatewayOptions = {}) {
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  /** Normalize a raw tweet, skipping (not aborting) any that fail validation. */
  private normalizeOrSkip(raw: unknown): SourceTweet | null {
    try {
      return normalizeTweet(raw);
    } catch (err) {
      console.warn(`[twitterapi] skipping malformed tweet: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async *fetchAuthoredTweets(
    userName: string,
    sinceTime?: string,
  ): AsyncGenerator<SourceTweet, boolean> {
    let query = `from:${userName}`;
    if (sinceTime) {
      const unixSeconds = Math.floor(new Date(sinceTime).getTime() / 1000);
      query += ` since_time:${unixSeconds}`;
    }
    let cursor = "";
    for (let page = 0; page < this.maxPages; page++) {
      const data = await this.client.get<unknown>("/twitter/tweet/advanced_search", {
        query,
        queryType: "Latest",
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      // "Latest" returns newest-first. The API does not reliably honor since_time, so
      // stop client-side once we reach a tweet at/older than the watermark — everything
      // after it is older still. Without this, collect crawls the entire tweet history.
      let reachedWatermark = false;
      for (const raw of tweets) {
        const t = this.normalizeOrSkip(raw);
        if (!t) continue;
        if (sinceTime && t.createdAt <= sinceTime) {
          reachedWatermark = true;
          break;
        }
        yield t;
      }
      // Natural stop: watermark reached, last page, or a cursor that isn't advancing.
      if (reachedWatermark || !hasNextPage || !nextCursor || nextCursor === cursor) return false;
      cursor = nextCursor;
    }
    // Fell out of the loop → hit the page cap (DEFAULT_MAX_PAGES, or whatever `maxPages` the
    // caller injected) with more pages available.
    return true;
  }

  async fetchThread(tweetId: string): Promise<SourceTweet[]> {
    const out: SourceTweet[] = [];
    let cursor = "";
    for (let page = 0; page < this.maxPages; page++) {
      const data = await this.client.get<unknown>("/twitter/tweet/thread_context", {
        tweetId,
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      for (const raw of tweets) {
        const t = this.normalizeOrSkip(raw);
        if (t) out.push(t);
      }
      if (!hasNextPage || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return out;
  }

  /**
   * `/twitter/tweets` caps `tweet_ids` at 50 and answers a longer list with
   * `HTTP 400: max 50 tweet_ids per request, please batch into multiple calls`.
   *
   * The chunking is here rather than in the callers because the cap belongs to the endpoint, and
   * leaving it to callers had already failed twice by the time it was found (2026-08-19):
   * `RecordImpressions` handed over all 74 rows of `history` at once, so `pnpm impressions:record`
   * failed on every argument-less run; `ReconcileDeletions` chunked, but at 100, so `pnpm reconcile`
   * broke as soon as the account passed 50 live posts. Only `BackfillVideoUrls` picked 50, and it
   * had to write a comment justifying the number to do it. A caller may still chunk for its own
   * reasons — that one reports per-batch progress — and a chunk smaller than this one costs nothing.
   */
  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    if (ids.length === 0) return [];
    const out: SourceTweet[] = [];
    for (let i = 0; i < ids.length; i += MAX_TWEET_IDS_PER_REQUEST) {
      const data = await this.client.get<unknown>("/twitter/tweets", {
        tweet_ids: ids.slice(i, i + MAX_TWEET_IDS_PER_REQUEST).join(","),
      });
      const { tweets } = parseTweetList(data);
      for (const raw of tweets) {
        const t = this.normalizeOrSkip(raw);
        if (t) out.push(t);
      }
    }
    return out;
  }

  async fetchArticle(tweetId: string): Promise<ArticleBlock[]> {
    const data = await this.client.get<unknown>("/twitter/article", { tweet_id: tweetId });
    return parseArticleContents(data);
  }

  /** Account profile (followers / statusesCount) for a handle, used for volume/cost estimation
   *  and by app-layer use cases via the SourceGateway port. */
  async fetchUserProfile(userName: string): Promise<UserProfile> {
    const data = await this.client.get<unknown>("/twitter/user/info", { userName });
    return parseUserProfile(data, userName);
  }
}
