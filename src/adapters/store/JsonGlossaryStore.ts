import { join } from "node:path";
import type { GlossaryEntry } from "../../domain/translation/models";
import type { GlossaryStore } from "../../ports/GlossaryStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonGlossaryStore implements GlossaryStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "glossary.json");
  }
  async load(): Promise<GlossaryEntry[]> {
    return readJsonFile<GlossaryEntry[]>(this.path, []);
  }
  async upsertEntry(entry: GlossaryEntry): Promise<void> {
    const all = await this.load();
    const byTerm = new Map(all.map((e) => [e.term, e]));
    byTerm.set(entry.term, entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byTerm.values()]);
  }
}
