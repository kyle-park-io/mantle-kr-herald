import { join } from "node:path";
import type { PublishStore } from "../../ports/PublishStore";
import { entryKey, migrateLegacyKeys, type SyncEntry } from "../../domain/publish/syncLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  entries?: SyncEntry[];
  /** Legacy format, still read so no manual migration is needed. */
  published?: string[];
}

export class JsonPublishStore implements PublishStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "state.json");
  }

  async listEntries(): Promise<SyncEntry[]> {
    const state = await readJsonFile<StateFile>(this.path, {});
    if (state.entries) return state.entries;
    return migrateLegacyKeys(state.published ?? []);
  }

  async listPublished(): Promise<Set<string>> {
    return new Set((await this.listEntries()).map(entryKey));
  }

  async record(entry: SyncEntry): Promise<void> {
    const entries = await this.listEntries();
    const key = entryKey(entry);
    const next = entries.filter((e) => entryKey(e) !== key);
    next.push(entry);
    await writeJsonFileAtomic(this.dir, this.path, { entries: next } satisfies StateFile);
  }
}
