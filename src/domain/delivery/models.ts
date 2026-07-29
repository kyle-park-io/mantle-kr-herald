import type { ChannelSentEntry } from "../send/channels";
import { PRIMARY_OUTLET_BY_CHANNEL } from "../outlet/models";

/**
 * One piece of copy delivered to one room.
 *
 * `sent` is an observation — a bot or API call succeeded — and is never reversed.
 * `delivered` is a claim: a human ticked 전달함 after pasting it by hand, and can untick it.
 * `dropped` is a scheduled send that provably never reached the room: an X post goes out as a
 * Typefully draft first, and a draft can be deleted before it publishes. The row stays in
 * `loadAll()` — the board still explains what happened — but it must stop meaning "this room
 * already has this copy", or the room is stranded forever.
 */
export interface DeliveryEntry {
  itemId: string;
  type: string;
  outletId: string;
  status: "sent" | "delivered" | "dropped";
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
 * Whether a ledger row still means "this room already has this copy" — the one question every
 * ledger's `loadKeys()` answers before gating a re-send. False for a `dropped` `DeliveryEntry` and
 * for a row carrying `droppedAt` (`XArticleSentEntry` retires this way instead, since it has no
 * `status` field to widen); both shapes mean the same thing: a scheduled Typefully draft was deleted
 * before it published, so nothing ever reached the room or the account.
 *
 * ONE predicate, shared by every ledger's `loadKeys()` — the same rule `sendBlock` and `isStale`
 * follow. The moment two places decide "already delivered" independently, they can disagree, and
 * disagreement here is a duplicate live post.
 */
export function deliveredToRoom(row: { status?: string; droppedAt?: string }): boolean {
  return row.status !== "dropped" && row.droppedAt === undefined;
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
