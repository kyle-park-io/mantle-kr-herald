import type { Destination } from "../formatting/emitters";
import type { ConversionType } from "../conversion/models";

export type SendableChannel = "telegram" | "x";

/** The API-delivery destination a sender transports for each channel (vs the human copy-paste one). */
export const DELIVERY_DESTINATION: Record<SendableChannel, Destination> = {
  telegram: "telegram_bot",
  x: "x_typefully",
};

export interface ChannelSentEntry {
  itemId: string;
  type: string;
  channel: SendableChannel;
  postId?: string;
  url?: string;
  senderName: string;
  sentAt: string;
}

export function sentKey(e: Pick<ChannelSentEntry, "itemId" | "type" | "channel">): string {
  return `${e.itemId}:${e.type}:${e.channel}`;
}

export interface SentArchiveEntry {
  itemId: string;
  type: ConversionType;
  channel: SendableChannel;
  /**
   * The room this copy actually went to. Required, and part of `sentFileName`: two auto rooms share
   * a channel, and `upload()` creates rather than replaces, so a channel-named archive would put two
   * same-named files in the Drive `sent/` folder carrying different message ids.
   */
  outletId: string;
  text: string;
  postId?: string;
  url?: string;
  sentAt: string;
}
