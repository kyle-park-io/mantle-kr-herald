import type { SourceTweet } from "../../domain/models";
import type { SourceGateway } from "../../ports/SourceGateway";
import type { IHttpClient } from "../../shared/http/IHttpClient";
import { normalizeTweet, parseTweetList } from "./schemas";

// Safety backstop so a non-terminating cursor or a full-history/large-thread crawl
// can never loop forever (20 tweets/page → up to ~1000 tweets).
const MAX_PAGES = 50;

export class TwitterApiSourceGateway implements SourceGateway {
  constructor(private readonly client: IHttpClient) {}

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
  ): AsyncGenerator<SourceTweet> {
    let query = `from:${userName}`;
    if (sinceTime) {
      const unixSeconds = Math.floor(new Date(sinceTime).getTime() / 1000);
      query += ` since_time:${unixSeconds}`;
    }
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
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
      // Stop at the watermark, the last page, or a cursor that isn't advancing.
      if (reachedWatermark || !hasNextPage || !nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
  }

  async fetchThread(tweetId: string): Promise<SourceTweet[]> {
    const out: SourceTweet[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
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

  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    if (ids.length === 0) return [];
    const data = await this.client.get<unknown>("/twitter/tweets", {
      tweet_ids: ids.join(","),
    });
    const { tweets } = parseTweetList(data);
    return tweets
      .map((raw) => this.normalizeOrSkip(raw))
      .filter((t): t is SourceTweet => t !== null);
  }
}
