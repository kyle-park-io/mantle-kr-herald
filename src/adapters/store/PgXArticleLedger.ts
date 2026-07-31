import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import { deliveredToRoom } from "../../domain/delivery/models";
import type { XArticleLedger, XArticleSentEntry } from "../../ports/XArticleLedger";

/** The shape a row from `x_article_deliveries` (see `src/adapters/db/schema.ts`) comes back as. */
interface XArticleRow {
  item_id: string;
  post_id: string | null;
  url: string | null;
  sent_at: string;
  dropped_at: string | null;
}

function toXArticleSentEntry(row: XArticleRow): XArticleSentEntry {
  return omitNulls({
    itemId: row.item_id,
    postId: row.post_id,
    url: row.url,
    sentAt: row.sent_at,
    droppedAt: row.dropped_at,
  });
}

/**
 * `XArticleLedger` backed by the `x_article_deliveries` table. Replaces `JsonXArticleLedger` — the
 * other send ledger `src/shared/store/serialWrites.ts` describes: a lost or mis-keyed row here is a
 * live X-article post the ledger can no longer see, which the next run posts a second time. The
 * in-process serializer and cross-process file lock `JsonXArticleLedger` wrapped its read-modify-write
 * in are both gone: `add`'s `insert ... on conflict` is one statement, so there is no read-modify-write
 * left for two overlapping writers to race, and the `item_id` primary key on `x_article_deliveries`
 * does the job the file lock used to.
 *
 * `upsert` fully replaces the row on conflict — matching `JsonXArticleLedger.add`'s `byId.set(...)`,
 * which discards whatever the previous entry held rather than merging field by field. A re-`add()`
 * that omits `droppedAt` therefore clears a previous drop, same as before.
 */
export class PgXArticleLedger implements XArticleLedger {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<XArticleSentEntry[]> {
    const rows = await this.db.query<XArticleRow>(
      `select item_id, post_id, url, sent_at, dropped_at
       from x_article_deliveries
       order by ordinal`,
    );
    return rows.map(toXArticleSentEntry);
  }

  /**
   * Excludes a `droppedAt` row via the shared `deliveredToRoom` predicate — nothing ever reached the
   * account, so `itemId` must stay sendable. The same predicate `JsonXArticleLedger.loadKeys()` and
   * `PgDeliveryLedger.loadKeys()` use, so this store cannot answer "already posted" differently.
   */
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.loadAll()).filter(deliveredToRoom).map((e) => e.itemId));
  }

  /**
   * One `insert ... on conflict (item_id) do update` statement — no `loadAll` + merge + rewrite —
   * so two concurrent `add()`s of different rows can never race and drop one. The `on conflict`
   * clause never assigns `ordinal`: that column is set once by `bigserial` on the initial insert and
   * an update leaves it alone, so `loadAll()`'s `order by ordinal` keeps reproducing insertion order
   * even after a row has been re-added (e.g. a scheduled draft that later resolves to a live `url`).
   */
  async add(entry: XArticleSentEntry): Promise<void> {
    await this.db.query(
      `insert into x_article_deliveries (item_id, post_id, url, sent_at, dropped_at)
       values ($1, $2, $3, $4, $5)
       on conflict (item_id) do update set
         post_id = excluded.post_id,
         url = excluded.url,
         sent_at = excluded.sent_at,
         dropped_at = excluded.dropped_at`,
      [entry.itemId, entry.postId ?? null, entry.url ?? null, entry.sentAt, entry.droppedAt ?? null],
    );
  }
}
