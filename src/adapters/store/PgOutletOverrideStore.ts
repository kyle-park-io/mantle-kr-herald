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
 * never splits it — it recomputes `overrideKey` for every loaded row and filters out the one that
 * matches the whole string. `remove` here does the same thing in SQL instead of parsing the key
 * apart: `item_id || ':' || type || ':' || outlet_id` mirrors `overrideKey` in
 * `src/domain/outlet/override.ts` byte for byte, so a `where` on that expression is the whole-string
 * comparison the Json store makes, not a split. This matters because `type` reaches this store
 * unvalidated — `apiHandlers.ts` takes it straight off the URL segment, unlike the sibling
 * convert/format routes — so a colon in `type` (or, just as easily, in `itemId` or `outletId`) is
 * reachable at runtime even though nothing on the frontend sends one today. A split that assumed
 * which segments were which could misassign the parts and silently match zero rows; recomputing
 * the key instead is immune to a colon in *any* field. If `overrideKey`'s shape ever changes, this
 * expression must change with it.
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
    await this.db.query(
      // Mirrors `overrideKey` (src/domain/outlet/override.ts): `${itemId}:${type}:${outletId}`.
      "delete from outlet_overrides where item_id || ':' || type || ':' || outlet_id = $1",
      [key],
    );
  }
}
