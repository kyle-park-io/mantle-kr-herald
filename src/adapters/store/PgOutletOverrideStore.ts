import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { OutletOverride } from "../../domain/outlet/override";
import type { OutletOverrideStore } from "../../ports/OutletOverrideStore";

/** The shape a row from `outlet_overrides` (see `src/adapters/db/schema.ts`) comes back as. */
interface OutletOverrideRow {
  item_id: string;
  type: string;
  outlet_id: string;
  text: string;
  status: string;
  created_at: string;
  approved_at: string | null;
}

function toOutletOverride(row: OutletOverrideRow): OutletOverride {
  return omitNulls({
    itemId: row.item_id,
    type: row.type,
    outletId: row.outlet_id,
    text: row.text,
    status: row.status as OutletOverride["status"],
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  });
}

/**
 * Splits a key built by `overrideKey` (`${itemId}:${type}:${outletId}`) back into its parts.
 * `itemId` itself contains a colon (`"x:<rootId>"` / `"lark:<messageId>"`), so a plain
 * `key.split(":")` cannot assume three pieces — the last two colon-separated segments are
 * `outletId` and `type`, and everything left over, rejoined with `:`, is `itemId`.
 */
function parseOverrideKey(key: string): { itemId: string; type: string; outletId: string } {
  const parts = key.split(":");
  const outletId = parts.pop() ?? "";
  const type = parts.pop() ?? "";
  return { itemId: parts.join(":"), type, outletId };
}

/**
 * `OutletOverrideStore` backed by the `outlet_overrides` table. Replaces `JsonOutletOverrideStore`.
 *
 * `upsert` is one `insert ... on conflict (item_id, type, outlet_id) do update` statement — no
 * `loadAll` + merge + rewrite — so two concurrent upserts of different rows can never race and
 * drop one. The `on conflict` clause never assigns `ordinal`: that column is set once by
 * `bigserial` on the initial insert and an update leaves it alone, so `loadAll()`'s
 * `order by ordinal` keeps reproducing insertion order — the same order `JsonOutletOverrideStore`
 * produces by appending to `overrides.json` — even after a row has been edited.
 *
 * `remove` takes the same joined string key `JsonOutletOverrideStore.remove` does. That store
 * never actually splits it — it recomputes `overrideKey` for every loaded row and filters out the
 * one that matches the whole string. A SQL `delete` instead needs the three parts of the primary
 * key, so `parseOverrideKey` above reverses `overrideKey`'s join the same way `overrideKey` builds
 * it, so the two agree on every key this store is ever asked to remove.
 */
export class PgOutletOverrideStore implements OutletOverrideStore {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<OutletOverride[]> {
    const rows = await this.db.query<OutletOverrideRow>(
      `select item_id, type, outlet_id, text, status, created_at, approved_at
       from outlet_overrides
       order by ordinal`,
    );
    return rows.map(toOutletOverride);
  }

  async upsert(o: OutletOverride): Promise<void> {
    await this.db.query(
      `insert into outlet_overrides
         (item_id, type, outlet_id, text, status, created_at, approved_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (item_id, type, outlet_id) do update set
         text = excluded.text,
         status = excluded.status,
         created_at = excluded.created_at,
         approved_at = excluded.approved_at`,
      [o.itemId, o.type, o.outletId, o.text, o.status, o.createdAt, o.approvedAt ?? null],
    );
  }

  async remove(key: string): Promise<void> {
    const { itemId, type, outletId } = parseOverrideKey(key);
    await this.db.query(
      "delete from outlet_overrides where item_id = $1 and type = $2 and outlet_id = $3",
      [itemId, type, outletId],
    );
  }
}
