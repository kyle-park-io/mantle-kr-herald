import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      "auth_attempts", "deliveries", "few_shot_examples", "lark_items", "lineage", "outlet_overrides",
      "publish_entries", "renderings", "translations", "variants", "x_article_deliveries", "x_threads",
    ]);
  });

  it("is idempotent — applying twice does not throw", async () => {
    db = await createTestDb();
    const { applySchema } = await import("../../../src/adapters/db/schema");
    await expect(applySchema(db)).resolves.not.toThrow();
  });

  // Task 4.5: idempotency must hold at the column level too, not just "no throw" — a second
  // `applySchema` run must leave `translations` with exactly the columns it had, neither duplicating
  // an altered column nor dropping one.
  it("is idempotent for altered columns — applying twice leaves the same column set on translations", async () => {
    db = await createTestDb();
    const { applySchema } = await import("../../../src/adapters/db/schema");
    const columnsOf = async () =>
      (
        await db!.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'translations' order by column_name",
        )
      ).map((r) => r.column_name);

    const before = await columnsOf();
    await applySchema(db);
    await applySchema(db);
    expect(await columnsOf()).toEqual(before);
    expect(before).toContain("posted_url");
    expect(before).toContain("posted_at");
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

describe("ALTERED_COLUMNS", () => {
  // Guards the Task 4.5 fix itself: `ALTERED_COLUMNS` must be *derived* from schema.ts's own
  // `alter table ... add column ...` statements, not a second, hand-maintained list — the exact
  // failure mode this task exists to close (a hand-written column list drifting from what
  // `applySchema` actually runs is indistinguishable, at review time, from one that is correct).
  //
  // This reads schema.ts's raw source text and re-derives the same list with its own, independent
  // regex, rather than importing `STATEMENTS` (not exported) or reusing schema.ts's own regex. That
  // means this test fails not only if `ALTERED_COLUMNS` is ever hand-edited out of sync, but also if
  // a future `alter table ... add column` statement is phrased in a shape schema.ts's own derivation
  // regex fails to recognize (e.g. dropping `if not exists`) — the two independent parses would then
  // disagree even though `ALTERED_COLUMNS` still "derives from the source" by construction.
  it("is derived from every `alter table ... add column` statement in schema.ts, not hand-written twice", async () => {
    const { ALTERED_COLUMNS } = await import("../../../src/adapters/db/schema");
    const schemaPath = fileURLToPath(new URL("../../../src/adapters/db/schema.ts", import.meta.url));
    const source = readFileSync(schemaPath, "utf8");
    const found = [...source.matchAll(/alter table (\w+) add column(?: if not exists)? (\w+)/gi)].map((m) => ({
      table: m[1],
      column: m[2],
    }));
    expect(found.length).toBeGreaterThan(0);
    expect(ALTERED_COLUMNS).toEqual(found);
  });

  it("includes translations.posted_url and translations.posted_at — the columns Task 4.5 exists for", async () => {
    const { ALTERED_COLUMNS } = await import("../../../src/adapters/db/schema");
    expect(ALTERED_COLUMNS).toContainEqual({ table: "translations", column: "posted_url" });
    expect(ALTERED_COLUMNS).toContainEqual({ table: "translations", column: "posted_at" });
  });
});
