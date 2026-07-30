import type { ChannelPost } from "../domain/kol/models";

export interface FetchPostsInWindowResult {
  posts: ChannelPost[]; // oldest first
  /**
   * `true` only when the sweep gave up because it hit the implementation's page-count cap before
   * finishing the window — never for a normal exit (an empty page, or a page that already predates
   * `startISO`). A truncated sweep's `posts` are still real and still worth keeping; the flag exists
   * so the caller can tell "the channel posted less this month" apart from "we stopped looking".
   */
  truncated: boolean;
}

export interface TelegramChannelGateway {
  /**
   * Posts on a public Telegram channel within `[startISO, endExclusiveISO)`, oldest first.
   * Half-open, matching `monthWindow`'s `endExclusiveISO`.
   */
  fetchPostsInWindow(
    handle: string,
    startISO: string,
    endExclusiveISO: string,
  ): Promise<FetchPostsInWindowResult>;
}
