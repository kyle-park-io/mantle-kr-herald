import type { SourceTweet } from "../domain/models";

export interface SourceGateway {
  /**
   * Authored tweets newer than sinceTime (ISO), streamed via pagination.
   * Returns true if it stopped because it hit the MAX_PAGES cap with more pages
   * still available (coverage may be incomplete below sinceTime); false if it
   * reached a natural stop (watermark, last page, or a stalled cursor).
   */
  fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet, boolean>;
  /** Full thread for a conversation/root tweet id. */
  fetchThread(tweetId: string): Promise<SourceTweet[]>;
  /** Existence check: returns only tweets still alive among the given ids. */
  fetchByIds(ids: string[]): Promise<SourceTweet[]>;
}
