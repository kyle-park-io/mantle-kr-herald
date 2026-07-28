import type { SendableChannel } from "../domain/send/channels";

export interface SendRequest {
  itemId: string;
  type: string;
  channel: SendableChannel;
  /** Per-post strings already spelled for the delivery destination by emit(). */
  segments: string[];
  /** Photo URLs to attach to the lead post (undefined/empty = text only). */
  photos?: string[];
}

export interface SendResult {
  postId?: string;
  url?: string;
}

export interface ChannelSender {
  /** Deliver the segments. Throws on an API error — the use-case isolates that per item. */
  send(req: SendRequest): Promise<SendResult>;
  readonly name: string; // "telegram" | "x" — stable key for the ledger + reporting
}
