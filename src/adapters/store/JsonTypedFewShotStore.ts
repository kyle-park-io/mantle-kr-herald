import { join } from "node:path";
import { ALL_TYPES, type ConversionType } from "../../domain/conversion/models";
import type { FewShotExample } from "../../domain/translation/models";
import type { FewShotStore } from "../../ports/FewShotStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

/** Per-type few-shot store: `few-shot.<type>.json`. Same upsert-by-itemId semantics as JsonFewShotStore. */
export class JsonTypedFewShotStore implements FewShotStore {
  private readonly path: string;
  constructor(private readonly dir: string, type: ConversionType) {
    this.path = join(dir, `few-shot.${type}.json`);
  }
  async load(): Promise<FewShotExample[]> {
    return readJsonFile<FewShotExample[]>(this.path, []);
  }
  async add(ex: FewShotExample): Promise<void> {
    const all = await this.load();
    if (ex.itemId !== undefined) {
      const idx = all.findIndex((e) => e.itemId === ex.itemId);
      if (idx >= 0) all[idx] = ex;
      else all.push(ex);
    } else {
      all.push(ex);
    }
    await writeJsonFileAtomic(this.dir, this.path, all);
  }
}

/** One store per conversion type, built from ALL_TYPES so a new type needs no wiring here. */
export function fewShotStoresByType(dir: string): Record<ConversionType, FewShotStore> {
  const byType = {} as Record<ConversionType, FewShotStore>;
  for (const type of ALL_TYPES) byType[type] = new JsonTypedFewShotStore(dir, type);
  return byType;
}
