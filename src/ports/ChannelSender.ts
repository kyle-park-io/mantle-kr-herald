import type { SendableChannel } from "../domain/send/channels";

export interface SendRequest {
  itemId: string;
  type: string;
  channel: SendableChannel;
  /** Per-post strings already spelled for the delivery destination by emit(). */
  segments: string[];
  /** Photo URLs to attach to the lead post (undefined/empty = text only). */
  photos?: string[];
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
