import { join } from "node:path";
import type { ChannelRendering } from "../../domain/formatting/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

const key = (r: Pick<ChannelRendering, "itemId" | "type" | "channel">) => `${r.itemId}:${r.type}:${r.channel}`;

export class JsonFormattingStore implements FormattingStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "renderings.json");
  }
  async loadAll(): Promise<ChannelRendering[]> {
    return readJsonFile<ChannelRendering[]>(this.path, []);
  }
  async upsert(r: ChannelRendering): Promise<void> {
    const all = await this.loadAll();
    const byKey = new Map(all.map((x) => [key(x), x]));
    byKey.set(key(r), r);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async listRenderedKeys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map(key));
  }
}
