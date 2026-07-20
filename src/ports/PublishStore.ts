import type { SyncEntry } from "../domain/publish/syncLedger";

export interface PublishStore {
  /** Every recorded upload, one row per (itemId, status, target). */
  listEntries(): Promise<SyncEntry[]>;
  /** Upsert one entry by its key. */
  record(entry: SyncEntry): Promise<void>;
}
