import type { ChannelPost } from "../domain/kol/models";

export interface TelegramChannelGateway {
  /**
   * Posts on a public Telegram channel within `[startISO, endExclusiveISO)`, oldest first.
   * Half-open, matching `monthWindow`'s `endExclusiveISO`.
   */
  fetchPostsInWindow(handle: string, startISO: string, endExclusiveISO: string): Promise<ChannelPost[]>;
}
