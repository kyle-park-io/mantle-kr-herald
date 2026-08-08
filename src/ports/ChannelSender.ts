import type { SendableChannel } from "../domain/send/channels";

export interface SendRequest {
  itemId: string;
  type: string;
  channel: SendableChannel;
  /** Per-post strings already spelled for the delivery destination by emit(). */
  segments: string[];
  /** Photo URLs to attach to the lead post (undefined/empty = text only). */
  photos?: string[];
  /**
   * The one mp4 to attach to the lead post — the url a `[영상]` marker carries — or absent.
   *
   * Singular because X's rule is singular: a post takes at most one video, and never alongside
   * photos. A `string[]` here would let a sender build the payload X rejects; a `string` cannot, so
   * the only place that combination has to be refused is `SendChannels`, before any upload happens.
   * Only `TypefullySender` acts on it — Telegram video delivery does not exist yet, which is why
   * `SendChannels` never sets it for Telegram rather than leaving it to be silently ignored.
   */
  video?: string;
  /** Overrides the sender's configured chat id. Set per outlet; absent = the configured one. */
  chatId?: string;
  /** Pin the posted message in the room. Only Telegram acts on it. */
  pin?: boolean;
}

export interface SendResult {
  postId?: string;
  url?: string;
  /** Something after the post went wrong; the post itself is live. Never a reason to treat the send as failed. */
  warning?: string;
}

export interface ChannelSender {
  /** Deliver the segments. Throws on an API error — the use-case isolates that per item. */
  send(req: SendRequest): Promise<SendResult>;
  readonly name: string; // "telegram" | "x" — stable key for the ledger + reporting
}
