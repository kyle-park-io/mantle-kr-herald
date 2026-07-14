/** Keyed incremental watermark (e.g. per account or per chat). ISO 8601 times. */
export interface WatermarkStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, time: string): Promise<void>;
}
