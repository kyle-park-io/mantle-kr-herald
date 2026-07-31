import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { CollectedThread, CollectionStatus, SourceTweet } from "../../domain/models";
import type { CollectionRepository } from "../../ports/CollectionRepository";

/**
 * The shape a row from `x_threads` (see `src/adapters/db/schema.ts`) comes back as. `tweets` is a
 * `json` column; both `pg` and PGlite parse a `json`/`jsonb` column to a plain JS value on read (see
 * `pg-types`'s `register(114, JSON.parse)`), so it arrives already an array — never a string to
 * `JSON.parse` here.
 */
interface XThreadRow {
  root_id: string;
  tweets: SourceTweet[];
  status: string;
  first_seen_at: string;
  deleted_at: string | null;
}

function toCollectedThread(row: XThreadRow): CollectedThread {
  return omitNulls({
    rootId: row.root_id,
    tweets: row.tweets,
    status: row.status as CollectionStatus,
    firstSeenAt: row.first_seen_at,
    deletedAt: row.deleted_at,
  });
}

/**
 * Incoming otherwise wins outright (metrics legitimately change between runs), but an article's
 * `blocks` must not regress: a gap-fill via `fetchThread` never carries `article` at all (the
 * twitterapi.io thread_context endpoint omits the field), and a routine re-normalize from
 * `advanced_search` never carries `blocks` either (only `CollectAuthoredContent.fillArticleBodies`
 * fetches those, and only when they are not already stored). Without this, either path silently
 * replaces a stored 77-block article body with a bare t.co link on the next collect.
 *
 * Ported unchanged from `LocalJsonStore.mergeTweet` — same rule, same test, still TypeScript rather
 * than SQL: it is domain logic, not something an `on conflict` clause can express.
 */
function mergeTweet(existing: SourceTweet | undefined, incoming: SourceTweet): SourceTweet {
  if (!existing?.article) return incoming;
  const article = incoming.article?.blocks?.length ? incoming.article : existing.article;
  return { ...incoming, article };
}

/** Ported unchanged from `LocalJsonStore.mergeTweets`. */
function mergeTweets(existing: SourceTweet[], incoming: SourceTweet[]): SourceTweet[] {
  const existingById = new Map(existing.map((t) => [t.id, t]));
  const byId = new Map<string, SourceTweet>();
  for (const t of existing) byId.set(t.id, t);
  for (const t of incoming) byId.set(t.id, mergeTweet(existingById.get(t.id), t));
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/**
 * `CollectionRepository` backed by the `x_threads` table. Replaces the `CollectionRepository` half
 * of `LocalJsonStore`; the `WatermarkStore` half (`get`/`set` over `x/state.json`) stays on disk —
 * `collect` is a local job per the spec — so `LocalJsonStore` remains in the tree for that, and this
 * class implements `CollectionRepository` only.
 *
 * `tweets` is a `json` column, not `jsonb` (see the comment on the table in
 * `src/adapters/db/schema.ts`: `jsonb` would normalize key order and break `db:export`'s
 * byte-for-byte reproduction of the original files). Because of that, every write here passes an
 * already-`JSON.stringify`'d string for `tweets`, never the raw array: `pg`'s parameter
 * serialization treats a bare JS array as a Postgres array literal (`{...}`), not JSON — only a
 * string parameter is stored as the column's JSON text.
 *
 * `upsert` merges by `rootId`, preserving `firstSeenAt` and each tweet's article body per
 * `mergeTweet` above — the same rule `LocalJsonStore.upsert` applies, ported unchanged because it is
 * domain logic already covered by tests, not something SQL should re-derive. Since the merge needs
 * each thread's *previous* stored tweets, "one statement per write" here means one targeted
 * `select ... where root_id = any($1)` — reading only the rows this batch might merge into, never
 * `loadAll()` — followed by one `insert ... on conflict (root_id) do update` per thread. The whole
 * batch runs inside `db.tx()` so a failure partway through rolls back the threads already written in
 * the same call, matching `LocalJsonStore.upsert`'s single atomic file write. The `on conflict`
 * clause never assigns `ordinal`, so `loadAll()`'s `order by ordinal` keeps reproducing insertion
 * order even after a thread has been re-merged.
 */
export class PgCollectionRepository implements CollectionRepository {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<CollectedThread[]> {
    const rows = await this.db.query<XThreadRow>(
      `select root_id, tweets, status, first_seen_at, deleted_at
       from x_threads
       order by ordinal`,
    );
    return rows.map(toCollectedThread);
  }

  async upsert(threads: CollectedThread[]): Promise<void> {
    if (threads.length === 0) return;
    await this.db.tx(async (tx) => {
      const rootIds = threads.map((t) => t.rootId);
      const existingRows = await tx.query<Pick<XThreadRow, "root_id" | "tweets" | "first_seen_at">>(
        `select root_id, tweets, first_seen_at from x_threads where root_id = any($1)`,
        [rootIds],
      );
      const existingByRoot = new Map(existingRows.map((r) => [r.root_id, r]));

      for (const incoming of threads) {
        const existing = existingByRoot.get(incoming.rootId);
        const tweets = mergeTweets(existing?.tweets ?? [], incoming.tweets);
        const firstSeenAt = existing?.first_seen_at ?? incoming.firstSeenAt;
        await tx.query(
          `insert into x_threads (root_id, tweets, status, first_seen_at, deleted_at)
           values ($1, $2, $3, $4, $5)
           on conflict (root_id) do update set
             tweets = excluded.tweets,
             status = excluded.status,
             first_seen_at = excluded.first_seen_at,
             deleted_at = excluded.deleted_at`,
          [incoming.rootId, JSON.stringify(tweets), incoming.status, firstSeenAt, incoming.deletedAt ?? null],
        );
      }
    });
  }

  async listActiveTweetIds(): Promise<string[]> {
    const rows = await this.db.query<Pick<XThreadRow, "tweets">>(
      `select tweets from x_threads where status = 'active' order by ordinal`,
    );
    const ids: string[] = [];
    for (const row of rows) for (const t of row.tweets) ids.push(t.id);
    return ids;
  }

  /**
   * One `update` statement — no read first. `json_array_elements` unpacks each row's `tweets`
   * column so `exists` can test id membership directly in SQL; unlike `upsert`, there is no merge
   * rule here to lose by writing it as SQL, just a containment check. Only rows already
   * `status = 'active'` are touched, matching `LocalJsonStore.markDeleted`'s own guard, and
   * `deleted_at`/`status` are the only columns ever set, so `ordinal` is never touched.
   */
  async markDeleted(tweetIds: string[], deletedAt: string): Promise<void> {
    if (tweetIds.length === 0) return;
    await this.db.query(
      `update x_threads
       set status = 'deleted', deleted_at = $2
       where status = 'active'
         and exists (
           select 1 from json_array_elements(tweets) as tweet
           where tweet ->> 'id' = any($1)
         )`,
      [tweetIds, deletedAt],
    );
  }
}
