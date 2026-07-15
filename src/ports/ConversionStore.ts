import type { ContentVariant } from "../domain/conversion/models";

export interface ConversionStore {
  loadAll(): Promise<ContentVariant[]>;
  upsert(v: ContentVariant): Promise<void>; // by (itemId, type)
  listConvertedKeys(): Promise<Set<string>>; // `${itemId}:${type}`
}
