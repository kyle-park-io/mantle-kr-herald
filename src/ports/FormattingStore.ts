import type { ChannelRendering } from "../domain/formatting/models";

/**
 * The key `listRenderedKeys` returns, in the one place its shape is decided.
 *
 * It used to be a comment on the method plus a private `key` in each store, which was enough while
 * the set was only ever produced. It is now also *consumed*: `FormatVariants`' only-missing mode
 * (`src/app/FormatVariants.ts`) asks this set whether a (item, type, channel) already has a
 * rendering, and skips it if so. A consumer that rebuilt the string inline would keep compiling
 * forever after a store changed the separator — and would match nothing, which in that mode does not
 * mean "skip nothing", it means **overwrite every approved rendering on the board**. That failure
 * has no error, no log line and no way back.
 */
export function renderingKey(r: Pick<ChannelRendering, "itemId" | "type" | "channel">): string {
  return `${r.itemId}:${r.type}:${r.channel}`;
}

export interface FormattingStore {
  loadAll(): Promise<ChannelRendering[]>;
  upsert(r: ChannelRendering): Promise<void>; // by (itemId, type, channel)
  /** Every pair that already has a rendering, keyed by `renderingKey` above. */
  listRenderedKeys(): Promise<Set<string>>;
}
