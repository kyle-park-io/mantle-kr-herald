import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import type { DeliveryEntry } from "../../domain/delivery/models";
import { deliveryKey, migrateLegacyEntry } from "../../domain/delivery/models";
import type { DeliveryLedger } from "../../ports/DeliveryLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonDeliveryLedger implements DeliveryLedger {
  private readonly path: string;
  private readonly legacyPath: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "deliveries.json");
    this.legacyPath = join(dir, "channels.json");
  }

  /** Raw read of `deliveries.json` only — `null` when it does not exist yet. No legacy fallback. */
  private loadCurrent(): Promise<DeliveryEntry[] | null> {
    return readJsonFile<DeliveryEntry[] | null>(this.path, null);
  }

  /**
   * Reads the outlet-keyed file, falling back to the pre-outlet `channels.json` when it is absent.
   * The migration is read-only: the legacy file is never rewritten or deleted, so a rollback loses
   * nothing. The first `add()` writes `deliveries.json`, after which the legacy file is ignored.
   */
  async loadAll(): Promise<DeliveryEntry[]> {
    const current = await this.loadCurrent();
    if (current) return current;
    const legacy = await readJsonFile<ChannelSentEntry[]>(this.legacyPath, []);
    return legacy.map(migrateLegacyEntry);
  }

  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).map(deliveryKey));
  }

  /**
   * Writes are based on `deliveries.json` alone, never on the migrated legacy fallback — otherwise
   * the first `add()` while only `channels.json` exists would bake every migrated legacy row into
   * the new file as a side effect of adding one entry.
   */
  async add(entry: DeliveryEntry): Promise<void> {
    const current = (await this.loadCurrent()) ?? [];
    const byKey = new Map(current.map((e) => [deliveryKey(e), e]));
    byKey.set(deliveryKey(entry), entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }

  async remove(key: string): Promise<void> {
    const current = (await this.loadCurrent()) ?? [];
    const kept = current.filter((e) => deliveryKey(e) !== key);
    await writeJsonFileAtomic(this.dir, this.path, kept);
  }
}
