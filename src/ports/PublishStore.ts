import type { SyncEntry } from "../domain/publish/syncLedger";

export interface PublishStore {
  /** Every recorded upload, one row per (itemId, status, target). */
  listEntries(): Promise<SyncEntry[]>;
  /** Set of "<itemId>:<status>:<target>" keys already uploaded — the idempotency check. */
  listPublished(): Promise<Set<string>>;
  /** Upsert one entry by its key. */
  record(entry: SyncEntry): Promise<void>;
}
