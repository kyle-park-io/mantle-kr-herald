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
