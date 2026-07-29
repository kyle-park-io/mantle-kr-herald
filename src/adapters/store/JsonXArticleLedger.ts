import { join } from "node:path";
import { deliveredToRoom } from "../../domain/delivery/models";
import { withFileLock } from "../../shared/store/fileLock";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";
import { createSerializer } from "../../shared/store/serialWrites";

export interface XArticleSentEntry {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
  /** Set when the scheduled Typefully draft was deleted before it published — see `deliveredToRoom`. */
  droppedAt?: string;
}

export class JsonXArticleLedger {
  private readonly path: string;
  private readonly serial = createSerializer();
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
   * `serial` orders this instance's writes; `withFileLock` orders them against other processes,
   * whose independent serializer would otherwise interleave a read-modify-write and drop a row —
   * an X article the ledger can no longer see, which the next run posts to the account again.
   * The lock is on this ledger's own path: two files, two locks, so a delivery write never waits
   * behind an unrelated X-article write.
   */
  async add(entry: XArticleSentEntry): Promise<void> {
    return this.serial(() =>
      withFileLock(this.path, async () => {
        const byId = new Map((await this.load()).map((e) => [e.itemId, e]));
        byId.set(entry.itemId, entry);
        await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
      }),
    );
  }
}
