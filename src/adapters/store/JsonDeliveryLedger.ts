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

  /**
   * Reads the outlet-keyed file, falling back to the pre-outlet `channels.json` when it is absent.
   * The migration is read-only: the legacy file is never rewritten or deleted, so a rollback loses
   * nothing.
   *
   * `add()`/`remove()` use this same method as their read-modify-write base (not a raw read of
   * `deliveries.json` alone). That is deliberate: a migrated legacy row records a real send — often
   * to a live Telegram room or X account — and once any unrelated write persists it into
   * `deliveries.json`, it must keep appearing in `loadKeys()` afterwards. Basing writes on a
   * legacy-blind read would let an already-sent item silently become indistinguishable from
   * never-sent the moment any unrelated entry is added, and `SendChannels.run()` gates re-sending
   * solely on `loadKeys()` — so that gap becomes a duplicate live post, not just a stale label.
   */
  async loadAll(): Promise<DeliveryEntry[]> {
    const current = await readJsonFile<DeliveryEntry[] | null>(this.path, null);
    if (current) return current;
    const legacy = await readJsonFile<ChannelSentEntry[]>(this.legacyPath, []);
    return legacy.map(migrateLegacyEntry);
  }

  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).map(deliveryKey));
  }

  private queue: Promise<void> = Promise.resolve();
  /**
   * Serializes writes on this instance. `writeJsonFileAtomic` makes each write all-or-nothing, but
   * add/remove are read-modify-write: two overlapping calls both read the same file and the second
   * rename silently discards the first one's row. The dashboard runs a reconcile pass every two
   * minutes against the same instance the send path uses, so that overlap is now routine — and a
   * dropped `sent` row means a live scheduled post the ledger cannot see, which the next run re-sends.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    // The second `fn` is deliberate: a rejected predecessor must not prevent the next write from
    // running, or one failed write would wedge every write on this instance after it.
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async add(entry: DeliveryEntry): Promise<void> {
    return this.serial(async () => {
      const byKey = new Map((await this.loadAll()).map((e) => [deliveryKey(e), e]));
      byKey.set(deliveryKey(entry), entry);
      await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
    });
  }

  async remove(key: string): Promise<void> {
    return this.serial(async () => {
      const kept = (await this.loadAll()).filter((e) => deliveryKey(e) !== key);
      await writeJsonFileAtomic(this.dir, this.path, kept);
    });
  }
}
