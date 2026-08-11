import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestDb, createUnmigratedTestDb } from "../../support/testDb";
import { isSchemaApplied, applySchema } from "../../../src/adapters/db/schema";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("applySchema", () => {
  it("creates every table the stores need", async () => {
    db = await createTestDb();
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "auth_attempts", "credential_liveness", "deliveries", "few_shot_examples", "lark_items", "lineage",
      "outlet_overrides", "publish_entries", "renderings", "translate_floor_reports", "translations",
      "variants", "x_article_deliveries", "x_threads",
    ]);
  });

  it("is idempotent — applying twice does not throw", async () => {
    db = await createTestDb();
    await expect(applySchema(db)).resolves.not.toThrow();
  });

  // Task 4.5: idempotency must hold at the column level too, not just "no throw" — a second
  // `applySchema` run must leave `translations` with exactly the columns it had, neither duplicating
  // an altered column nor dropping one.
  it("is idempotent for altered columns — applying twice leaves the same column set on translations", async () => {
    db = await createTestDb();
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

/**
 * Strips `//` line comments and block comments, JSDoc included, from a TypeScript source string,
 * leaving only executable code. Used below so a doc comment that quotes an `alter table ... add
 * column` shape for explanatory purposes (schema.ts's own `ALTERED_COLUMNS` comment does exactly
 * that, describing the Task 4.5 review finding) is never mistaken for a second, real occurrence of
 * that SQL in the executable source.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("ALTERED_COLUMNS", () => {
  const schemaPath = fileURLToPath(new URL("../../../src/adapters/db/schema.ts", import.meta.url));

  /**
   * Task 4.5 review: the previous version of this file *parsed* `alter table ... add column ...`
   * SQL out of `STATEMENTS` to build `ALTERED_COLUMNS`, mirroring `TABLE_NAMES`. Mutation testing on
   * real source proved the parse regex under-matches a multi-line statement, a quoted identifier, and
   * two columns added in one statement — and because the production regex and this test's regex were
   * nearly identical, they agreed with each other while both were silently wrong. The fix removes the
   * parse entirely: `ALTERED_COLUMNS` (`schema.ts`) is now declared as data, and `STATEMENTS`'
   * `alter table` statements are *generated* from it via `alterColumnStatement` — there is no longer
   * any SQL for a regex to under-match.
   *
   * This test guards that invariant from the other direction: it asserts `alterColumnStatement`'s
   * template literal is the *only* place `schema.ts`'s executable source spells out an
   * `alter table ... add column` statement. A future author who hand-writes a new one directly into
   * `STATEMENTS` — bypassing `ALTERED_COLUMNS` the way the pre-fix code always allowed — produces a
   * second occurrence and this goes red, regardless of how that statement is formatted (multi-line,
   * quoted identifier, multiple columns per statement all still contain the literal words "alter
   * table ... add column" somewhere in their text, which is all this counts).
   *
   * Reproduced the reviewer's own mutation to confirm this actually catches it: temporarily adding
   *   `alter table translations\n  add column if not exists some_col text`
   * directly into `STATEMENTS` turns this from 1 match to 2, and the test fails — see task-4.5-report.md.
   */
  it("writes `alter table ... add column` SQL in exactly one place — a hand-written ALTER cannot bypass ALTERED_COLUMNS", () => {
    const source = stripComments(readFileSync(schemaPath, "utf8"));
    const matches = source.match(/alter\s+table\s+\S+\s+add\s+column/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  /**
   * The other half of the invariant: not only is there nowhere else to write the SQL by hand, but
   * every declared entry actually becomes a real column once `applySchema` runs. Combined with the
   * test above, this is what "the generated statements and the probe's expected set come from the
   * same list" means operationally — `isSchemaApplied` (`schema.ts`) checks these same
   * `ALTERED_COLUMNS` entries against `information_schema.columns`, so a column present here but
   * never actually created (or vice versa) would show up as a mismatch here, not just in production.
   */
  it("is not empty, and every declared column is actually created by applySchema", async () => {
    const { ALTERED_COLUMNS } = await import("../../../src/adapters/db/schema");
    expect(ALTERED_COLUMNS.length).toBeGreaterThan(0);

    db = await createTestDb();
    const rows = await db.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public'",
    );
    const existing = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    for (const { table, column } of ALTERED_COLUMNS) {
      expect(existing.has(`${table}.${column}`)).toBe(true);
    }
  });

  it("includes translations.posted_url and translations.posted_at — the columns Task 4.5 exists for", async () => {
    const { ALTERED_COLUMNS } = await import("../../../src/adapters/db/schema");
    expect(ALTERED_COLUMNS).toContainEqual(expect.objectContaining({ table: "translations", column: "posted_url" }));
    expect(ALTERED_COLUMNS).toContainEqual(expect.objectContaining({ table: "translations", column: "posted_at" }));
  });
});

/**
 * Task 4.5: `isSchemaApplied` used to check `TABLE_NAMES` only (`information_schema.tables`), so a
 * database with every table `applySchema` creates but missing a column it later added via `alter
 * table ... add column if not exists` still reported "applied". That is exactly what broke `pnpm
 * x:reconcile` against the real production database — `translations` existed, but `posted_url`/
 * `posted_at` did not, and nothing before that command's own run had ever migrated it (`applySchema`
 * was only reachable from `serve.ts`, `db-import.ts`, `db-export.ts` — none of which `x:reconcile`
 * calls; Task 4.5 also added `pnpm db:migrate` for that gap — see `dbMigrate.test.ts`).
 *
 * Lives here, not in a `tests/cli/dbStores.test.ts`, because `isSchemaApplied` itself lives in
 * `schema.ts` now (Task 4.5 review, Minor: layering) — tests mirror `src`'s own module boundaries.
 */
describe("isSchemaApplied", () => {
  it("reports false against a database that has never been migrated", async () => {
    db = await createUnmigratedTestDb();
    expect(await isSchemaApplied(db)).toBe(false);
  });

  it("reports true after applySchema has run", async () => {
    db = await createTestDb();
    expect(await isSchemaApplied(db)).toBe(true);
  });

  // The table itself exists (created by createTestDb()'s own applySchema run) — only the altered
  // column is missing. A table-only probe would say "applied" here; this is the exact regression
  // Task 4.5 exists to close.
  it("reports false when a table exists but an alter-table column is missing", async () => {
    db = await createTestDb();
    await db.query("alter table translations drop column posted_url");
    expect(await isSchemaApplied(db)).toBe(false);
  });

  it("reports false for any missing altered column, not only the first one checked", async () => {
    db = await createTestDb();
    await db.query("alter table translations drop column posted_at");
    expect(await isSchemaApplied(db)).toBe(false);
  });

  it("reports true again once applySchema restores the missing column", async () => {
    db = await createTestDb();
    await db.query("alter table translations drop column posted_url");
    expect(await isSchemaApplied(db)).toBe(false);
    await applySchema(db);
    expect(await isSchemaApplied(db)).toBe(true);
  });
});
