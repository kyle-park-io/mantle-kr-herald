import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import type { DeliveryEntry } from "../../domain/delivery/models";
import { deliveredToRoom, deliveryKey, migrateLegacyEntry } from "../../domain/delivery/models";
import type { DeliveryLedger } from "../../ports/DeliveryLedger";
import { withFileLock } from "../../shared/store/fileLock";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";
import { createSerializer } from "../../shared/store/serialWrites";

export class JsonDeliveryLedger implements DeliveryLedger {
  private readonly path: string;
  private readonly legacyPath: string;
  private readonly serial = createSerializer();
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
   * never-sent the moment any unrelated entry is added — and that gap becomes a duplicate live post,
   * not just a stale label, because THREE separate deciders read these rows to answer "has this
   * already gone out":
   *
   * - `loadKeys()` below — the port's own answer, used by callers that just want the key set.
   * - `SendChannels.run()`'s `already` (`src/app/SendChannels.ts:124`) — the per-delivery gate,
   *   which recomputes the same question here rather than calling `loadKeys()`, because
   *   `planRooms` needs the raw rows too.
   * - `SendChannels.planRooms()`'s `everDelivered` (`src/app/SendChannels.ts:326`) — the
   *   first-delivery guard's "has this ROOM ever received anything", keyed by `outletId` rather
   *   than by delivery key.
   *
   * All three go through the shared `deliveredToRoom` predicate, and a fourth reader must too. This
   * sentence used to say the gate was `loadKeys()` alone; that was how `everDelivered` came to count
   * `dropped` rows as history for two releases — a grep for `loadKeys()` callers could not find it.
   */
  async loadAll(): Promise<DeliveryEntry[]> {
    const current = await readJsonFile<DeliveryEntry[] | null>(this.path, null);
    if (current) return current;
    const legacy = await readJsonFile<ChannelSentEntry[]>(this.legacyPath, []);
    return legacy.map(migrateLegacyEntry);
  }

  /**
   * Excludes `dropped` rows via `deliveredToRoom` — the deliberate counterpart to the warning above.
   * A row leaving `loadKeys()` is normally the live-resend hazard `loadAll()`'s legacy-aware read
   * exists to prevent; here it is the intended outcome, decided in exactly one place (the shared
   * predicate) rather than silently through a legacy-blind read, so `add()`/`remove()` above still
   * cannot make an unrelated write forget a real send.
   */
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).filter(deliveredToRoom).map(deliveryKey));
  }

  /**
   * The two layers of protection are deliberate and not redundant. `serial` orders writes issued by
   * this instance — cheap, in-memory, no syscalls. `withFileLock` orders them against *other
   * processes*: a `pnpm send:channels` run while the dashboard `pnpm serve` is up has two ledgers
   * over one file, and read-modify-write across two processes drops whichever row lost the rename.
   * A dropped row here is a send the ledger can no longer see, which the next run publishes again.
   */
  async add(entry: DeliveryEntry): Promise<void> {
    return this.serial(() =>
      withFileLock(this.path, async () => {
        const byKey = new Map((await this.loadAll()).map((e) => [deliveryKey(e), e]));
        byKey.set(deliveryKey(entry), entry);
        await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
      }),
    );
  }

  async remove(key: string): Promise<void> {
    return this.serial(() =>
      withFileLock(this.path, async () => {
        const kept = (await this.loadAll()).filter((e) => deliveryKey(e) !== key);
        await writeJsonFileAtomic(this.dir, this.path, kept);
      }),
    );
  }
}
