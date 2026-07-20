import type { PublishStore } from "../../src/ports/PublishStore";
import { entryKey, type SyncEntry } from "../../src/domain/publish/syncLedger";

/** In-memory PublishStore for tests: upserts by entryKey, exposes the raw rows for assertions. */
export class InMemoryPublishStore implements PublishStore {
  public entries: SyncEntry[] = [];

  get keys(): Set<string> {
    return new Set(this.entries.map(entryKey));
  }

  async listEntries(): Promise<SyncEntry[]> {
    return this.entries;
  }

  async record(entry: SyncEntry): Promise<void> {
    this.entries = this.entries.filter((e) => entryKey(e) !== entryKey(entry));
    this.entries.push(entry);
  }
}
