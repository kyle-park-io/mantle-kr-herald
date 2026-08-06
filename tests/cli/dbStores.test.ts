import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, createUnmigratedTestDb } from "../support/testDb";
import { isSchemaApplied } from "../../src/cli/dbStores";
import { applySchema } from "../../src/adapters/db/schema";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * Task 4.5: `isSchemaApplied` used to check `TABLE_NAMES` only (`information_schema.tables`), so a
 * database with every table `applySchema` creates but missing a column it later added via `alter
 * table ... add column if not exists` still reported "applied". That is exactly what broke `pnpm
 * x:reconcile` against the real production database — `translations` existed, but `posted_url`/
 * `posted_at` did not, and nothing before this run had ever migrated it (`applySchema` was only
 * reachable from `serve.ts`, `db-import.ts`, `db-export.ts` — none of which `x:reconcile` calls).
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
