import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("applySchema", () => {
  it("creates every table the stores need", async () => {
    db = await createTestDb();
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "deliveries", "few_shot_examples", "lark_items", "lineage", "outlet_overrides",
      "publish_entries", "renderings", "translations", "variants", "x_article_deliveries", "x_threads",
    ]);
  });

  it("is idempotent — applying twice does not throw", async () => {
    db = await createTestDb();
    const { applySchema } = await import("../../../src/adapters/db/schema");
    await expect(applySchema(db)).resolves.not.toThrow();
  });

  it("rejects a second delivery row for the same (item, type, outlet)", async () => {
    db = await createTestDb();
    const insert = `insert into deliveries (item_id, type, outlet_id, status, at, by)
                    values ($1, $2, $3, 'sent', '2026-07-29T00:00:00.000Z', 'auto')`;
    await db.query(insert, ["x:1", "announcement", "tg-community"]);
    await expect(db.query(insert, ["x:1", "announcement", "tg-community"])).rejects.toThrow();
  });

  /**
   * `deliveries`' unique constraint has a test above; `x_article_deliveries` — the ledger for the
   * brand's own X account, keyed by `item_id` alone (`JsonXArticleLedger.loadKeys()`/`add()`) — did
   * not. Both ledgers' in-adapter concurrency tests are deliberately relaxed to "at least one row
   * survives" (any implementation satisfies that), and their Pg counterparts self-document as unable
   * to fail on single-connection PGlite, so this was the one place left that could assert the key
   * actually rejects a duplicate at the database. A gap here means nothing on this branch proves the
   * ledger whose failure mode is a duplicate X Article on the brand's account.
   */
  it("rejects a second x-article-delivery row for the same item", async () => {
    db = await createTestDb();
    const insert = `insert into x_article_deliveries (item_id, sent_at) values ($1, '2026-07-29T00:00:00.000Z')`;
    await db.query(insert, ["x:1"]);
    await expect(db.query(insert, ["x:1"])).rejects.toThrow();
  });

  it("returns a stored JSON document with its key order intact — jsonb would reorder it", async () => {
    db = await createTestDb();
    const original = '{"z":1,"a":2,"m":{"y":3,"b":4}}';
    await db.query(
      "insert into x_threads (root_id, tweets, status, first_seen_at) values ($1, $2::json, 'active', '2026-01-01T00:00:00.000Z')",
      ["x:1", original],
    );
    const [row] = await db.query<{ tweets: string }>("select tweets::text as tweets from x_threads where root_id = $1", ["x:1"]);
    expect(row?.tweets).toBe(original);
  });
});
