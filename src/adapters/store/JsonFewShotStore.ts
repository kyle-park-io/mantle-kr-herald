import { join } from "node:path";
import type { FewShotExample } from "../../domain/translation/models";
import type { FewShotStore } from "../../ports/FewShotStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonFewShotStore implements FewShotStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "few-shot.json");
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
