import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import type { DeliveryEntry } from "../../domain/delivery/models";
import { deliveredToRoom, deliveryKey, migrateLegacyEntry } from "../../domain/delivery/models";
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
   * A plain read-modify-write — read the file once, mutate a Map in memory, write it back
   * atomically once. Correct for a single process with no concurrent writer, which is what this
   * store is for once `PgDeliveryLedger` takes over the live send path (Task 17): its only
   * remaining caller is `db:export`, run alone. Two overlapping callers on the same instance can
   * still drop a row the way any read-modify-write can — see `PgDeliveryLedger`, which protects
   * concurrent writers with a database transaction instead of the file lock and in-process queue
   * this store used to wrap `add`/`remove` in.
   *
   * `add`, `remove` and `replace` all funnel through this single read + single write so that none
   * of them ever leaves a gap of their own between reading the file and rewriting it — `replace` in
   * particular needs that: reading once, deleting `previous`'s key and setting `next`'s key on the
   * same in-memory Map before the one write back means there is no moment where the file on disk
   * holds neither row.
   */
  private async mutate(change: (byKey: Map<string, DeliveryEntry>) => void): Promise<void> {
    const byKey = new Map((await this.loadAll()).map((e) => [deliveryKey(e), e]));
    change(byKey);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }

  async add(entry: DeliveryEntry): Promise<void> {
    await this.mutate((byKey) => byKey.set(deliveryKey(entry), entry));
  }

  async remove(key: string): Promise<void> {
    await this.mutate((byKey) => byKey.delete(key));
  }

  /**
   * Deletes `previous`'s key and sets `next`'s key on the same in-memory Map — except when the two
   * keys are equal, in which case the `delete` is skipped and only `set` runs. That distinction
   * matters for order, not just correctness: `Map` iteration follows insertion order, and `set` on a
   * key already present updates its value in place without moving it, while `delete` followed by
   * `set` re-inserts the key at the end. `loadAll()`'s array order is exactly this Map's iteration
   * order, and `sendToOutlet.ts`'s actual resend shape never changes a row's key — only its
   * `status`/`postId`/`url` — so skipping the no-op delete keeps a same-key `replace()` from moving
   * the row, matching `PgDeliveryLedger.replace`'s equivalent fast path for `ordinal`.
   */
  async replace(previous: DeliveryEntry, next: DeliveryEntry): Promise<void> {
    await this.mutate((byKey) => {
      const previousKey = deliveryKey(previous);
      const nextKey = deliveryKey(next);
      if (previousKey !== nextKey) byKey.delete(previousKey);
      byKey.set(nextKey, next);
    });
  }
}
