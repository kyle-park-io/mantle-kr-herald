import type { CollectedThread } from "../domain/models";

export interface CollectionRepository {
  loadAll(): Promise<CollectedThread[]>;
  /** Merge by rootId; preserve existing firstSeenAt. */
  upsert(threads: CollectedThread[]): Promise<void>;
  /** All tweet ids belonging to active (non-deleted) threads. */
  listActiveTweetIds(): Promise<string[]>;
  /** Mark every active thread containing any of these ids as deleted. */
  markDeleted(tweetIds: string[], deletedAt: string): Promise<void>;
}
