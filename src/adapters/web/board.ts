// src/adapters/web/board.ts
import { ALL_TYPES, type ConversionType } from "../../domain/conversion/models";
import { ALL_CHANNELS, type Channel, type ChannelRendering } from "../../domain/formatting/models";
import { deliveredByChannelSender, outletsForChannel, type Outlet } from "../../domain/outlet/models";
import { overrideKey, textFor, type OutletOverride } from "../../domain/outlet/override";
import { deliveryKey, type DeliveryEntry } from "../../domain/delivery/models";
import { sendBlock, type SendBlock, type SourceApproval } from "../../domain/send/sendBlock";
import { awaitingPublish } from "../../domain/send/awaitingPublish";

/** One room under a group card: what it will send, and whether it already went out. */
export interface BoardRow {
  outletId: string;
  label: string;
  /** `auto` = a bot posts it ([발송]); `manual` = a human pastes it and ticks 전달함. */
  delivery: "auto" | "manual";
  /** This room has its own text — an override exists for (itemId, type, outletId). */
  forked: boolean;
  status: "rendered" | "approved";
  text: string;
  /**
   * Why this room cannot send yet, or absent when it can. From `sendBlock` — the same call
   * `SendChannels` makes — so a row that paints as sendable is exactly a row that sends.
   */
  block?: SendBlock;
  deliveryStatus?: "sent" | "delivered";
  /**
   * Sent, but the post is a scheduled Typefully draft that has not been looked up yet — so `at` is
   * when it was queued, `url` is missing, and the row must not claim to be live. See
   * `awaitingPublish`.
   */
  awaitingPublish?: boolean;
  at?: string;
  url?: string;
  /** How many rows on this board address this same room, and which of them this is (1-based). */
  siblingCount: number;
  siblingIndex: number;
}

/** One `(type, channel)` rendering plus the rooms that receive it. One card on screen. */
export interface BoardGroup {
  type: ConversionType;
  channel: Channel;
  text: string;
  status: "rendered" | "approved";
  rows: BoardRow[];
  /** Rooms on this channel not rowed yet — the "+ 방 추가" menu. */
  addableOutletIds: string[];
}

export interface BoardView {
  itemId: string;
  groups: BoardGroup[];
  /** Types with no rendering yet, in ALL_TYPES order — the "아직 변환 안 됨" line. */
  unconverted: ConversionType[];
}

type PendingRow = Omit<BoardRow, "siblingCount" | "siblingIndex">;

const rank = (list: readonly string[], value: string): number => {
  const i = list.indexOf(value);
  return i === -1 ? list.length : i; // an unknown type/channel sorts last rather than first
};

/**
 * Rooms a reviewer can actually finish with — bot-delivered, or pasted by hand.
 *
 * A room that is neither can never leave the board: the send route refuses it ("paste it and tick
 * 전달함") and `MarkDelivery` then refuses the tick *because* the room is `auto`, so the server
 * would be instructing an action it rejects. `x-article` is the one such room — `send:x-article`
 * posts it from the translation against its own ledger, so nothing it does can ever surface in
 * `deliveries.json` either. Rowing it, or offering it as addable, produces a card with no exit.
 */
const reachable = (o: Outlet): boolean => deliveredByChannelSender(o) || o.delivery === "manual";

/**
 * The board for one item: one card per `(type, channel)` rendering, each listing the rooms that
 * receive it.
 *
 * Pure by design — the caller loads the renderings, the overrides and the delivery ledger, which is
 * what lets every rule below be tested without touching a store.
 *
 * `suggestedTypes` decides which rooms are rowed *by default*; it is not a constraint. A room the
 * operator reached for — one that already carries an override or a delivery for this
 * `(itemId, type)` — is rowed too, so it stays visible on every later load instead of disappearing
 * the moment the page is refreshed.
 */
export function buildBoard(
  itemId: string,
  renderings: ChannelRendering[],
  overrides: OutletOverride[],
  deliveries: DeliveryEntry[],
  /** The 1차 translation these renderings descend from; `undefined` blocks every row, loudly. */
  translation: SourceApproval | undefined,
): BoardView {
  const mine = renderings.filter((r) => r.itemId === itemId);
  const overrideByKey = new Map(overrides.map((o) => [overrideKey(o), o] as const));
  const deliveryByKey = new Map(deliveries.map((e) => [deliveryKey(e), e] as const));

  // Identity is (type, channel) — the formatting store's own key, so a duplicate can only be
  // corrupt data. Keep the first and move on rather than rendering the same card twice.
  const byGroup = new Map<string, ChannelRendering>();
  for (const r of mine) {
    const key = `${r.type}:${r.channel}`;
    if (!byGroup.has(key)) byGroup.set(key, r);
  }

  // Sorted rather than left in store order: the group order decides the `n/m` numbering below, and
  // a room reading `1/2` on one load and `2/2` on the next would be read as a different room.
  const ordered = [...byGroup.values()].sort(
    (a, b) => rank(ALL_TYPES, a.type) - rank(ALL_TYPES, b.type) || rank(ALL_CHANNELS, a.channel) - rank(ALL_CHANNELS, b.channel),
  );

  const groups = ordered.map((r) => {
    const outlets = outletsForChannel(r.channel).filter(reachable);
    const keyOf = (o: Outlet) => overrideKey({ itemId, type: r.type, outletId: o.id });
    const touched = (o: Outlet) =>
      overrideByKey.has(keyOf(o)) || deliveryByKey.has(deliveryKey({ itemId, type: r.type, outletId: o.id }));

    // Two segments, each in `outletsForChannel` order: the suggested rooms, then the rooms the
    // operator added. An unknown channel yields no outlets at all, so the card still renders.
    const suggested = outlets.filter((o) => o.suggestedTypes.includes(r.type));
    const added = outlets.filter((o) => !suggested.includes(o) && touched(o));
    const rowed = [...suggested, ...added];
    const rowedIds = new Set(rowed.map((o) => o.id));

    const rows: PendingRow[] = rowed.map((o) => {
      const resolved = textFor(r, overrideByKey.get(keyOf(o)));
      const entry = deliveryByKey.get(deliveryKey({ itemId, type: r.type, outletId: o.id }));
      const block = sendBlock(resolved, translation);
      return {
        outletId: o.id,
        label: o.label,
        delivery: o.delivery,
        forked: resolved.forked,
        status: resolved.status,
        text: resolved.text,
        ...(block ? { block } : {}),
        ...(entry ? { deliveryStatus: entry.status, at: entry.at, url: entry.url } : {}),
        ...(entry && awaitingPublish(entry) ? { awaitingPublish: true } : {}),
      };
    });

    return {
      type: r.type,
      channel: r.channel,
      text: r.text,
      status: r.status,
      rows,
      addableOutletIds: outlets.filter((o) => !rowedIds.has(o.id)).map((o) => o.id),
    };
  });

  // Counted across the whole board, not per group: 데브방 receiving both 공지 and 해설 is exactly
  // the case the `n/m` badge exists for.
  const total = new Map<string, number>();
  for (const g of groups) for (const row of g.rows) total.set(row.outletId, (total.get(row.outletId) ?? 0) + 1);
  const seen = new Map<string, number>();

  const numbered: BoardGroup[] = groups.map((g) => ({
    ...g,
    rows: g.rows.map((row) => {
      const index = (seen.get(row.outletId) ?? 0) + 1;
      seen.set(row.outletId, index);
      return { ...row, siblingIndex: index, siblingCount: total.get(row.outletId) ?? 1 };
    }),
  }));

  const converted = new Set(mine.map((r) => r.type));
  return { itemId, groups: numbered, unconverted: ALL_TYPES.filter((t) => !converted.has(t)) };
}
