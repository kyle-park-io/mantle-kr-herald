import { join } from "node:path";
import type { OutletOverride } from "../../domain/outlet/override";
import { overrideKey } from "../../domain/outlet/override";
import type { OutletOverrideStore } from "../../ports/OutletOverrideStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonOutletOverrideStore implements OutletOverrideStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "overrides.json");
  }
  loadAll(): Promise<OutletOverride[]> {
    return readJsonFile<OutletOverride[]>(this.path, []);
  }
  async upsert(o: OutletOverride): Promise<void> {
    const byKey = new Map((await this.loadAll()).map((e) => [overrideKey(e), e]));
    byKey.set(overrideKey(o), o);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async remove(key: string): Promise<void> {
    const kept = (await this.loadAll()).filter((e) => overrideKey(e) !== key);
    await writeJsonFileAtomic(this.dir, this.path, kept);
  }
}
