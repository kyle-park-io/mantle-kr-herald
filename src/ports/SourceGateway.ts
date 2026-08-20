import type { ArticleBody, SourceTweet, UserProfile } from "../domain/models";

export interface SourceGateway {
  /**
   * Authored tweets newer than sinceTime (ISO), streamed via pagination.
   * Returns true if it stopped because it hit its own page cap with more pages
   * still available (coverage may be incomplete below sinceTime); false if it
   * reached a natural stop (watermark, last page, or a stalled cursor).
   */
  fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet, boolean>;
  /** Full thread for a conversation/root tweet id. */
  fetchThread(tweetId: string): Promise<SourceTweet[]>;
  /** Existence check: returns only tweets still alive among the given ids. */
  fetchByIds(ids: string[]): Promise<SourceTweet[]>;
  /**
   * The X Article carried by a tweet — metadata and body blocks together. A tweet payload never
   * includes an article's body, so this is a second call per article. `undefined` for a tweet that
   * is not an article.
   *
   * It returns the metadata as well as the blocks because the two callers know different amounts
   * going in. `CollectAuthoredContent` reads `advanced_search`, whose tweets carry the title,
   * excerpt and cover already, and wants only the body. `CollectLinkedThread` reads
   * `thread_context`, whose tweets carry no article key whatsoever — for it this call is the only
   * source of any of it, and a blocks-only answer left it unable to build an `ArticleBody` at all.
   */
  fetchArticle(tweetId: string): Promise<ArticleBody | undefined>;
  /** Account profile (followers / statusesCount) for a handle. */
  fetchUserProfile(userName: string): Promise<UserProfile>;
}
