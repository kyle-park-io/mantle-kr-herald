import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import { ALL_TYPES, type ConversionType } from "../../domain/conversion/models";
import type { FewShotExample } from "../../domain/translation/models";
import type { FewShotStore } from "../../ports/FewShotStore";

/** The shape a row from `few_shot_examples` (see `src/adapters/db/schema.ts`) comes back as. */
interface FewShotRow {
  item_id: string | null;
  source: string;
  target: string;
}

function toFewShotExample(row: FewShotRow): FewShotExample {
  return omitNulls({ source: row.source, target: row.target, itemId: row.item_id });
}

/**
 * `FewShotStore` backed by the `few_shot_examples` table, scoped by a `scope` string this class
 * takes in its constructor. Replaces both `JsonFewShotStore` (`scope: "translation"`, one instance
 * per corpus file — `translation/few-shot.json`) and `JsonTypedFewShotStore` (`scope:
 * "conversion:<type>"`, one instance per `conversion/few-shot.<type>.json`) — the same table, the
 * same class, distinguished only by the string each instance was built with.
 *
 * `add` is one `insert ... on conflict (scope, item_id) do update` statement that gives both of
 * the port's documented behaviours for free, with no `if (itemId) ... else ...` branch in
 * application code: `few_shot_examples` declares `unique (scope, item_id)` with `item_id`
 * nullable, and Postgres never considers a `null` value equal to another `null` for a unique
 * constraint's purposes — see the schema's own comment. So when `ex.itemId` is present, a second
 * `add()` with the same `(scope, itemId)` collides with the first row's index entry and the `on
 * conflict` branch fires, replacing `source`/`target` in place — the port's "idempotent
 * re-approval". When `ex.itemId` is absent (`null` in the row), the row can never collide with any
 * other row's `null` in the same scope, so the statement always takes the plain-insert path — the
 * port's "otherwise appends". The `on conflict` clause never assigns `ordinal`, and `ordinal` is
 * this table's own primary key (not a separate unique column, since a nullable `item_id` cannot
 * anchor one), so `load()`'s `order by ordinal` keeps reproducing insertion order — the same order
 * `JsonFewShotStore.add`/`JsonTypedFewShotStore.add` produce by appending to (or replacing an entry
 * in) their corpus file — even after a row has been edited.
 */
export class PgFewShotStore implements FewShotStore {
  constructor(
    private readonly db: Db,
    private readonly scope: string,
  ) {}

  async load(): Promise<FewShotExample[]> {
    const rows = await this.db.query<FewShotRow>(
      `select item_id, source, target
       from few_shot_examples
       where scope = $1
       order by ordinal`,
      [this.scope],
    );
    return rows.map(toFewShotExample);
  }

  async add(ex: FewShotExample): Promise<void> {
    await this.db.query(
      `insert into few_shot_examples (scope, item_id, source, target)
       values ($1, $2, $3, $4)
       on conflict (scope, item_id) do update set
         source = excluded.source,
         target = excluded.target`,
      [this.scope, ex.itemId ?? null, ex.source, ex.target],
    );
  }
}

/** One store per conversion type, built from ALL_TYPES so a new type needs no wiring here. */
export function fewShotStoresByType(db: Db): Record<ConversionType, FewShotStore> {
  const byType = {} as Record<ConversionType, FewShotStore>;
  for (const type of ALL_TYPES) byType[type] = new PgFewShotStore(db, `conversion:${type}`);
  return byType;
}
