import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { LineageEntry, LineageStage } from "../../domain/lineage/models";
import type { LineageStore, LineageSummary } from "../../ports/LineageStore";

/** The shape a row from `lineage` (see `src/adapters/db/schema.ts`) comes back as. */
interface LineageRow {
  item_id: string;
  stage: string;
  variant: string | null;
  content: string;
  status: string | null;
  source_text: string | null;
  at: string;
}

function toLineageEntry(row: LineageRow): LineageEntry {
  return omitNulls({
    itemId: row.item_id,
    stage: row.stage as LineageStage,
    variant: row.variant,
    content: row.content,
    status: row.status,
    sourceText: row.source_text,
    at: row.at,
  });
}

interface LineageSummaryRow {
  item_id: string;
  entries: number;
  last_stage: string;
}

/**
 * `LineageStore` backed by the `lineage` table. Replaces `JsonlLineageStore`, which appended one
 * JSON line per entry to a `<sanitised itemId>.jsonl` file (one file per item). That file-per-item
 * mechanism does not translate to a shared table, but its observable behaviour does:
 *
 * `append` is a plain `insert` — no `on conflict`, no primary key on any domain column. `lineage`
 * has none: it is append-only history, the same role the `.jsonl` file's growing line count played,
 * so nothing here can collide and nothing here should. `ordinal` is a surrogate `bigserial primary
 * key` that exists only to give `load()` a stable `order by ordinal` — the same order the `.jsonl`
 * file's lines were already in, since a plain insert (like a plain `appendFile`) can only add to
 * the end.
 *
 * `listItems()` reproduces `JsonlLineageStore.listItems()`'s per-item summary — id, entry count,
 * and the stage of the *last* entry — as one `group by item_id` query instead of one file read per
 * item. "Last" means last by `at`, the entry's own timestamp, not last by insertion order: those
 * normally agree, but `at` is the field the port's doc comment and the Json version's summary
 * (`entries[entries.length - 1].stage`, taken from a file whose lines are already `at`-ordered)
 * both mean by "last". `array_agg(stage order by at desc, ordinal desc)`'s first element is that
 * stage; `ordinal` only breaks a tie between two entries recorded with the same `at`.
 */
export class PgLineageStore implements LineageStore {
  constructor(private readonly db: Db) {}

  async append(entry: LineageEntry): Promise<void> {
    await this.db.query(
      `insert into lineage (item_id, stage, variant, content, status, source_text, at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.itemId,
        entry.stage,
        entry.variant ?? null,
        entry.content,
        entry.status ?? null,
        entry.sourceText ?? null,
        entry.at,
      ],
    );
  }

  async load(itemId: string): Promise<LineageEntry[]> {
    const rows = await this.db.query<LineageRow>(
      `select item_id, stage, variant, content, status, source_text, at
       from lineage
       where item_id = $1
       order by ordinal`,
      [itemId],
    );
    return rows.map(toLineageEntry);
  }

  async listItems(): Promise<LineageSummary[]> {
    const rows = await this.db.query<LineageSummaryRow>(
      `select item_id, count(*)::int as entries,
         (array_agg(stage order by at desc, ordinal desc))[1] as last_stage
       from lineage
       group by item_id
       order by min(ordinal)`,
    );
    return rows.map((r) => ({ itemId: r.item_id, entries: r.entries, lastStage: r.last_stage as LineageStage }));
  }
}
