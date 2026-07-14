import type { SourceTweet } from "../domain/models";

export interface SourceGateway {
  /** Authored tweets newer than sinceTime (ISO), streamed via pagination. */
  fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet>;
  /** Full thread for a conversation/root tweet id. */
  fetchThread(tweetId: string): Promise<SourceTweet[]>;
  /** Existence check: returns only tweets still alive among the given ids. */
  fetchByIds(ids: string[]): Promise<SourceTweet[]>;
}
