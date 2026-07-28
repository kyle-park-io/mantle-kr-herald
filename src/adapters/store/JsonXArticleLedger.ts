import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export interface XArticleSentEntry {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
}

export class JsonXArticleLedger {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "x-article.json");
  }
  private load(): Promise<XArticleSentEntry[]> {
    return readJsonFile<XArticleSentEntry[]>(this.path, []);
  }
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.load()).map((e) => e.itemId));
  }
  loadAll(): Promise<XArticleSentEntry[]> {
    return this.load();
  }
  async add(entry: XArticleSentEntry): Promise<void> {
    const byId = new Map((await this.load()).map((e) => [e.itemId, e]));
    byId.set(entry.itemId, entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
  }
}
