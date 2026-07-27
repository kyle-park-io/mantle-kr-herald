import type { Destination } from "../formatting/emitters";

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
