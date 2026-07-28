import type { ChannelSentEntry } from "../send/channels";
import { PRIMARY_OUTLET_BY_CHANNEL } from "../outlet/models";

/**
 * One piece of copy delivered to one room.
 *
 * `sent` is an observation — a bot or API call succeeded — and is never reversed.
 * `delivered` is a claim: a human ticked 전달함 after pasting it by hand, and can untick it.
 */
export interface DeliveryEntry {
  itemId: string;
  type: string;
  outletId: string;
  status: "sent" | "delivered";
  at: string; // ISO
  by: "auto" | "manual";
  postId?: string;
  url?: string;
  senderName?: string;
}

export function deliveryKey(e: Pick<DeliveryEntry, "itemId" | "type" | "outletId">): string {
  return `${e.itemId}:${e.type}:${e.outletId}`;
}

/**
 * Re-key a pre-outlet ledger row. The old key carried a channel, so the room is unknowable —
 * attribute it to that channel's primary outlet, mirroring how `publish/state.json` migrates its
 * legacy `{published:[…]}` shape on read.
 */
export function migrateLegacyEntry(e: ChannelSentEntry): DeliveryEntry {
  return {
    itemId: e.itemId,
    type: e.type,
    outletId: PRIMARY_OUTLET_BY_CHANNEL[e.channel] ?? e.channel,
    status: "sent",
    at: e.sentAt,
    by: "auto",
    postId: e.postId,
    url: e.url,
    senderName: e.senderName,
  };
}
