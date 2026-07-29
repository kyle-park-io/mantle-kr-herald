import type { ChannelRendering } from "../formatting/models";

/**
 * One room's own copy of a rendering, stored only once the reviewer edits that room. Rooms with no
 * row here share the group text — the same shared-then-forked rule `FormatVariants` applies at the
 * channel layer, one level down.
 */
export interface OutletOverride {
  itemId: string;
  type: string;
  outletId: string;
  text: string;
  status: "rendered" | "approved";
  createdAt: string;
  approvedAt?: string;
}

export function overrideKey(o: Pick<OutletOverride, "itemId" | "type" | "outletId">): string {
  return `${o.itemId}:${o.type}:${o.outletId}`;
}

export interface ResolvedText {
  text: string;
  status: "rendered" | "approved";
  forked: boolean;
}

/** What a room actually sends: its override when it has one, else the group rendering. */
export function textFor(rendering: ChannelRendering, override: OutletOverride | undefined): ResolvedText {
  if (!override) return { text: rendering.text, status: rendering.status, forked: false };
  return { text: override.text, status: override.status, forked: true };
}
