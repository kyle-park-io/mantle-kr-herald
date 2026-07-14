import type { SourceTweet } from "../../domain/models";
import type { SourceGateway } from "../../ports/SourceGateway";
import type { IHttpClient } from "../../shared/http/IHttpClient";
import { normalizeTweet, parseTweetList } from "./schemas";

export class TwitterApiSourceGateway implements SourceGateway {
  constructor(private readonly client: IHttpClient) {}

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
    while (true) {
      const data = await this.client.get<unknown>("/twitter/tweet/advanced_search", {
        query,
        queryType: "Latest",
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      for (const raw of tweets) yield normalizeTweet(raw);
      if (!hasNextPage || !nextCursor) break;
      cursor = nextCursor;
    }
  }

  async fetchThread(tweetId: string): Promise<SourceTweet[]> {
    const out: SourceTweet[] = [];
    let cursor = "";
    while (true) {
      const data = await this.client.get<unknown>("/twitter/tweet/thread_context", {
        tweetId,
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      for (const raw of tweets) out.push(normalizeTweet(raw));
      if (!hasNextPage || !nextCursor) break;
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
    return tweets.map((raw) => normalizeTweet(raw));
  }
}
