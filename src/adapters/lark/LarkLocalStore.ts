import { join } from "node:path";
import type { LarkMessage } from "../../domain/larkMessage";
import type { LarkRepository } from "../../ports/LarkRepository";
import type { WatermarkStore } from "../../shared/store/WatermarkStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  watermarks?: Record<string, string>;
}

export class LarkLocalStore implements LarkRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "lark-items.json");
    this.statePath = join(dir, "lark-state.json");
  }

  async loadAll(): Promise<LarkMessage[]> {
    return readJsonFile<LarkMessage[]>(this.itemsPath, []);
  }

  async upsert(messages: LarkMessage[]): Promise<void> {
    const existing = await this.loadAll();
    const byId = new Map(existing.map((m) => [m.messageId, m]));
    for (const incoming of messages) byId.set(incoming.messageId, incoming);
    const merged = [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId),
    );
    await writeJsonFileAtomic(this.dir, this.itemsPath, merged);
  }

  async get(key: string): Promise<string | undefined> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    return state.watermarks?.[key];
  }

  async set(key: string, time: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    const watermarks = { ...(state.watermarks ?? {}), [key]: time };
    await writeJsonFileAtomic(this.dir, this.statePath, { watermarks } satisfies StateFile);
  }
}
