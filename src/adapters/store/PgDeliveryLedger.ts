import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { DeliveryEntry, DeliveryStatus } from "../../domain/delivery/models";
import { deliveredToRoom, deliveryKey } from "../../domain/delivery/models";
import type { DeliveryLedger } from "../../ports/DeliveryLedger";

/** The shape a row from `deliveries` (see `src/adapters/db/schema.ts`) comes back as. */
interface DeliveryRow {
  item_id: string;
  type: string;
  outlet_id: string;
  status: string;
  at: string;
  by: string;
  post_id: string | null;
  url: string | null;
  sender_name: string | null;
}

function toDeliveryEntry(row: DeliveryRow): DeliveryEntry {
  return omitNulls({
    itemId: row.item_id,
    type: row.type,
    outletId: row.outlet_id,
    status: row.status as DeliveryStatus,
    at: row.at,
    by: row.by as DeliveryEntry["by"],
    postId: row.post_id,
    url: row.url,
    senderName: row.sender_name,
  });
}

/**
 * `DeliveryLedger` backed by the `deliveries` table. Replaces `JsonDeliveryLedger` — one of the two
 * send ledgers `src/shared/store/serialWrites.ts` describes: a lost or mis-keyed row here is a live
 * post to a brand's Telegram room or X account that the ledger can no longer see, which the next run
 * publishes a second time. The in-process serializer and cross-process file lock `JsonDeliveryLedger`
 * wrapped its read-modify-write in are both gone: `add`'s `insert ... on conflict` is one statement,
 * so there is no read-modify-write left for two overlapping writers to race, and the
 * `(item_id, type, outlet_id)` primary key on `deliveries` is what used to be the file lock's job —
 * enforced by the database itself rather than by application code.
 *
 * `loadAll()` has no equivalent of `JsonDeliveryLedger`'s fallback to `channels.json`, and must not
 * grow one: that fallback is EXCLUSIVE, not additive. `JsonDeliveryLedger.loadAll()`'s
 * `readJsonFile(path, null)` returns `null` only when `deliveries.json` is entirely absent (ENOENT),
 * so `if (current) return current` means that the moment `deliveries.json` exists — even holding an
 * empty array — `channels.json` is ignored completely, never merged with it, even for a send that
 * only ever landed in the legacy file. `db:import` (Task 15) must inherit that same exclusivity, and
 * the way to get it for free is to import whatever `JsonDeliveryLedger.loadAll()` itself returns —
 * not to read and parse `deliveries.json` and `channels.json` separately and union the rows. A union
 * would resurrect a legacy row a `remove()` had already deleted (undoing an untick of 전달함) or
 * overwrite a current `dropped` row back to `sent`. Once that one-time import has run, `deliveries`
 * holds exactly what `JsonDeliveryLedger.loadAll()` would have returned, as ordinary rows
 * indistinguishable from ones `add()` wrote directly — so there is no second table for *this* store
 * to fall back to, and no run-time branch here reproduces `readJsonFile(..., null) ?? migrate(legacy)`.
 *
 * What must survive from the old fallback is the *semantics* it protected, not its mechanism: a
 * migrated legacy row is a real past send, and once it is a row in this table, an unrelated
 * `add()`/`remove()` for a different key must never make it disappear from `loadAll()` or
 * `loadKeys()`. That falls out of `add`/`remove` below touching only the row whose key matches — see
 * the "already-migrated row survives an unrelated add()" test.
 *
 * WARNING for whoever wires the cutover: that guarantee holds only *after* `db:import` has actually
 * run. The JSON version's safety net was automatic — a fresh `JsonDeliveryLedger` with no
 * `deliveries.json` fell back to `channels.json` with zero configuration required. This store has no
 * such net: it depends on nothing but `Db`, so an empty `deliveries` table looks to `loadKeys()`
 * exactly like a brand with no send history at all. Cut a hosted install over to Postgres without
 * running `db:import` first, and `SendChannels.run()`'s `already` and `planRooms()`'s
 * `everDelivered` both read "never sent" for a fully-populated send history — the next run re-posts
 * the entire backlog to live Telegram rooms and the brand's own X account. That is the exact failure
 * `serialWrites.ts` exists to prevent, at a far larger blast radius than the one-lost-row case it was
 * written about. Nothing in this class can defend against it — enforcing "import before first write"
 * is a property of the cutover procedure, not of this store.
 */
export class PgDeliveryLedger implements DeliveryLedger {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<DeliveryEntry[]> {
    const rows = await this.db.query<DeliveryRow>(
      `select item_id, type, outlet_id, status, at, by, post_id, url, sender_name
       from deliveries
       order by ordinal`,
    );
    return rows.map(toDeliveryEntry);
  }

  /**
   * Excludes rows `deliveredToRoom` says no longer mean "this room already has this copy" — today
   * that is only a `status: "dropped"` row, since a `DeliveryEntry` never carries `droppedAt`. The
   * same predicate `JsonDeliveryLedger.loadKeys()`, `SendChannels.run()`'s `already`, and
   * `SendChannels.planRooms()`'s `everDelivered` all use, so this store cannot answer "already sent"
   * differently than they do.
   */
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).filter(deliveredToRoom).map(deliveryKey));
  }

  /**
   * One `insert ... on conflict (item_id, type, outlet_id) do update` statement — no `loadAll` +
   * merge + rewrite — so two concurrent `add()`s of different rows can never race and drop one. The
   * `on conflict` clause never assigns `ordinal`: that column is set once by `bigserial` on the
   * initial insert and an update leaves it alone, so `loadAll()`'s `order by ordinal` keeps
   * reproducing insertion order even after a row has been re-added (e.g. a scheduled draft that
   * later resolves to a live `url`).
   */
  async add(entry: DeliveryEntry): Promise<void> {
    await this.db.query(
      `insert into deliveries
         (item_id, type, outlet_id, status, at, by, post_id, url, sender_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (item_id, type, outlet_id) do update set
         status = excluded.status,
         at = excluded.at,
         by = excluded.by,
         post_id = excluded.post_id,
         url = excluded.url,
         sender_name = excluded.sender_name`,
      [
        entry.itemId,
        entry.type,
        entry.outletId,
        entry.status,
        entry.at,
        entry.by,
        entry.postId ?? null,
        entry.url ?? null,
        entry.senderName ?? null,
      ],
    );
  }

  /**
   * `key` is the joined `deliveryKey()` string (`${itemId}:${type}:${outletId}`), never parsed
   * apart: `itemId` itself contains a colon (`"x:1"`), so a naive `split(":")` could misassign
   * segments and delete the wrong row, or none. Recomputing the same join in SQL and comparing it
   * whole — mirroring `deliveryKey` in `src/domain/delivery/models.ts` byte for byte — is immune to
   * a colon in any of the three fields.
   */
  async remove(key: string): Promise<void> {
    await this.db.query(
      "delete from deliveries where item_id || ':' || type || ':' || outlet_id = $1",
      [key],
    );
  }
}
