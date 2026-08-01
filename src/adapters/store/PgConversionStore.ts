import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { ContentVariant, ConversionType } from "../../domain/conversion/models";
import type { ConversionStore } from "../../ports/ConversionStore";

/** The shape a row from `variants` (see `src/adapters/db/schema.ts`) comes back as. */
interface VariantRow {
  item_id: string;
  type: string;
  source_korean: string;
  converted_text: string;
  status: string;
  created_at: string;
  approved_at: string | null;
}

function toContentVariant(row: VariantRow): ContentVariant {
  return omitNulls({
    itemId: row.item_id,
    type: row.type as ConversionType,
    sourceKorean: row.source_korean,
    convertedText: row.converted_text,
    status: row.status as ContentVariant["status"],
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  });
}

/**
 * `ConversionStore` backed by the `variants` table. Replaces `JsonConversionStore`.
 *
 * `upsert` is one `insert ... on conflict (item_id, type) do update` statement — no `loadAll` +
 * merge + rewrite — so two concurrent upserts of different rows can never race and drop one. The
 * `on conflict` clause never assigns `ordinal`: that column is set once by `bigserial` on the
 * initial insert and an update leaves it alone, so `loadAll()`'s `order by ordinal` keeps
 * reproducing insertion order — the same order `JsonConversionStore` produces by appending to
 * `variants.json` — even after a row has been edited.
 */
export class PgConversionStore implements ConversionStore {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<ContentVariant[]> {
    const rows = await this.db.query<VariantRow>(
      `select item_id, type, source_korean, converted_text, status, created_at, approved_at
       from variants
       order by ordinal`,
    );
    return rows.map(toContentVariant);
  }

  async upsert(v: ContentVariant): Promise<void> {
    await this.db.query(
      `insert into variants
         (item_id, type, source_korean, converted_text, status, created_at, approved_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (item_id, type) do update set
         source_korean = excluded.source_korean,
         converted_text = excluded.converted_text,
         status = excluded.status,
         created_at = excluded.created_at,
         approved_at = excluded.approved_at`,
      [v.itemId, v.type, v.sourceKorean, v.convertedText, v.status, v.createdAt, v.approvedAt ?? null],
    );
  }

  async listConvertedKeys(): Promise<Set<string>> {
    const rows = await this.db.query<{ item_id: string; type: string }>(
      "select item_id, type from variants",
    );
    return new Set(rows.map((r) => `${r.item_id}:${r.type}`));
  }
}
