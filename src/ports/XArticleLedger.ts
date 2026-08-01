/**
 * One row: an X article translation posted (or scheduled) through Typefully.
 *
 * `droppedAt` is how a row retires — set when the scheduled Typefully draft was deleted before it
 * published, so nothing ever reached the account. Unlike `DeliveryEntry` (`domain/delivery/models.ts`)
 * this shape has no `status` field to widen with a `"dropped"` value, which is why `deliveredToRoom`
 * accepts either shape: `status !== "dropped"` for a delivery row, `droppedAt === undefined` for this
 * one.
 */
export interface XArticleSentEntry {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
  droppedAt?: string;
}

/**
 * Extracted from `JsonXArticleLedger`'s public surface — the methods `ReconcilePublished`
 * (`src/app/ReconcilePublished.ts`), `SendXArticle` (`src/app/SendXArticle.ts`), and
 * `publishHeadroom.ts`'s headroom readers actually call: `loadKeys()` (the send gate's "already
 * posted" check), `loadAll()` (reconciliation and headroom's in-flight count), and `add()` (upsert
 * by `itemId`). No `remove()` — nothing in the codebase ever deletes an X-article row.
 */
export interface XArticleLedger {
  loadKeys(): Promise<Set<string>>;
  loadAll(): Promise<XArticleSentEntry[]>;
  add(entry: XArticleSentEntry): Promise<void>;
}
