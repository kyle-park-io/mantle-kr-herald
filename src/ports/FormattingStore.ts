import type { ChannelRendering } from "../domain/formatting/models";

export interface FormattingStore {
  loadAll(): Promise<ChannelRendering[]>;
  upsert(r: ChannelRendering): Promise<void>; // by (itemId, type, channel)
  listRenderedKeys(): Promise<Set<string>>; // `${itemId}:${type}:${channel}`
}
