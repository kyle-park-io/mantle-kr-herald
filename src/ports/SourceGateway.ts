import type { ArticleBlock, SourceTweet } from "../domain/models";

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
  /**
   * Body blocks for an X Article tweet. The search response marks a tweet as an article but never
   * includes its body, so this is a second call per article. Returns [] for a tweet that is not
   * an article.
   */
  fetchArticle(tweetId: string): Promise<ArticleBlock[]>;
}
