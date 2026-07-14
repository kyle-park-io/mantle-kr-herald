import { join } from "node:path";
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonTranslationStore implements TranslationStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "translations.json");
  }
  async loadAll(): Promise<Translation[]> {
    return readJsonFile<Translation[]>(this.path, []);
  }
  async upsert(t: Translation): Promise<void> {
    const all = await this.loadAll();
    const byId = new Map(all.map((x) => [x.itemId, x]));
    byId.set(t.itemId, t);
    await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
  }
  async listTranslatedIds(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map((t) => t.itemId));
  }
}
