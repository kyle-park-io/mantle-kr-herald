import { join } from "node:path";
import { deliveredToRoom } from "../../domain/delivery/models";
import type { XArticleLedger, XArticleSentEntry } from "../../ports/XArticleLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonXArticleLedger implements XArticleLedger {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "x-article.json");
  }
  private load(): Promise<XArticleSentEntry[]> {
    return readJsonFile<XArticleSentEntry[]>(this.path, []);
  }
  /** Excludes a `droppedAt` row — nothing ever reached the account, so `itemId` must stay sendable. */
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.load()).filter(deliveredToRoom).map((e) => e.itemId));
  }
  loadAll(): Promise<XArticleSentEntry[]> {
    return this.load();
  }
  /**
   * A plain read-modify-write, correct for a single process with no concurrent writer — see
   * `JsonDeliveryLedger.add` for why that is the only caller left once Task 17 lands, and
   * `PgXArticleLedger` for the store that protects concurrent writers with a database transaction
   * instead of the file lock and in-process queue this store used to wrap this method in.
   */
  async add(entry: XArticleSentEntry): Promise<void> {
    const byId = new Map((await this.load()).map((e) => [e.itemId, e]));
    byId.set(entry.itemId, entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
  }
}
