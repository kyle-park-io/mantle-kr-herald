import type { SyncEntry } from "../domain/publish/syncLedger";

export interface PublishStore {
  /** Every recorded upload, one row per (itemId, status, target). */
  listEntries(): Promise<SyncEntry[]>;
  /** Upsert one entry by its key. */
  record(entry: SyncEntry): Promise<void>;
  /** Remove the entry with this key (from a status-move prune). No-op if absent. */
  remove(key: string): Promise<void>;
}
