import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { Translation, TranslationStatus } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";

/** The shape a row from `translations` (see `src/adapters/db/schema.ts`) comes back as. */
interface TranslationRow {
  item_id: string;
  source: string;
  source_text: string;
  korean_text: string;
  status: string;
  translated_at: string;
  approved_at: string | null;
  is_reply: boolean | null;
  ref_url: string | null;
}

function toTranslation(row: TranslationRow): Translation {
  return omitNulls({
    itemId: row.item_id,
    source: row.source as Translation["source"],
    sourceText: row.source_text,
    koreanText: row.korean_text,
    status: row.status as TranslationStatus,
    translatedAt: row.translated_at,
    approvedAt: row.approved_at,
    isReply: row.is_reply,
    refUrl: row.ref_url,
  }) as Translation;
}

/**
 * `TranslationStore` backed by the `translations` table. Replaces `JsonTranslationStore`.
 *
 * `upsert` is one `insert ... on conflict (item_id) do update` statement — no `loadAll` +
 * merge + rewrite — so two concurrent upserts of different rows can never race and drop one.
 * The `on conflict` clause never assigns `ordinal`: that column is set once by `bigserial` on
 * the initial insert and an update leaves it alone, so `loadAll()`'s `order by ordinal` keeps
 * reproducing insertion order — the same order `JsonTranslationStore` produces by appending to
 * `translations.json` — even after a row has been edited.
 */
export class PgTranslationStore implements TranslationStore {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<Translation[]> {
    const rows = await this.db.query<TranslationRow>(
      `select item_id, source, source_text, korean_text, status, translated_at, approved_at, is_reply, ref_url
       from translations
       order by ordinal`,
    );
    return rows.map(toTranslation);
  }

  async upsert(t: Translation): Promise<void> {
    await this.db.query(
      `insert into translations
         (item_id, source, source_text, korean_text, status, translated_at, approved_at, is_reply, ref_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (item_id) do update set
         source = excluded.source,
         source_text = excluded.source_text,
         korean_text = excluded.korean_text,
         status = excluded.status,
         translated_at = excluded.translated_at,
         approved_at = excluded.approved_at,
         is_reply = excluded.is_reply,
         ref_url = excluded.ref_url`,
      [
        t.itemId,
        t.source,
        t.sourceText,
        t.koreanText,
        t.status,
        t.translatedAt,
        t.approvedAt ?? null,
        t.isReply ?? null,
        t.refUrl ?? null,
      ],
    );
  }

  async listTranslatedIds(): Promise<Set<string>> {
    const rows = await this.db.query<{ item_id: string }>("select item_id from translations");
    return new Set(rows.map((r) => r.item_id));
  }
}
