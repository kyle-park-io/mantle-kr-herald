import { join } from "node:path";
import type { ContentVariant } from "../../domain/conversion/models";
import type { ConversionStore } from "../../ports/ConversionStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

const key = (v: Pick<ContentVariant, "itemId" | "type">) => `${v.itemId}:${v.type}`;

export class JsonConversionStore implements ConversionStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "variants.json");
  }
  async loadAll(): Promise<ContentVariant[]> {
    return readJsonFile<ContentVariant[]>(this.path, []);
  }
  async upsert(v: ContentVariant): Promise<void> {
    const all = await this.loadAll();
    const byKey = new Map(all.map((x) => [key(x), x]));
    byKey.set(key(v), v);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async listConvertedKeys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map(key));
  }
}
