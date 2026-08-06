import { describe, it, expect, afterEach } from "vitest";
import { createUnmigratedTestDb } from "../support/testDb";
import { isSchemaApplied } from "../../src/adapters/db/schema";
import { migrate } from "../../src/cli/db-migrate";

let db: Awaited<ReturnType<typeof createUnmigratedTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * `pnpm db:migrate` — the thin CLI Task 4.5 adds over `applySchema`, for an operator who wants to
 * migrate a database explicitly rather than as a side effect of `pnpm serve` / `db:import --yes` /
 * `db:export --yes` (the only three places `applySchema` was reachable from before this command
 * existed). `migrate` is the exported function the runnable entry point below calls; these tests
 * exercise it directly the same way `dbImport.test.ts` exercises `importOutputTree` without running
 * the file's own guarded entry-point block.
 */
describe("migrate", () => {
  it("applies the schema to a database that has never been migrated", async () => {
    db = await createUnmigratedTestDb();
    expect(await isSchemaApplied(db)).toBe(false);
    await migrate(db);
    expect(await isSchemaApplied(db)).toBe(true);
  });

  it("is idempotent — running it twice does not throw and leaves the schema applied", async () => {
    db = await createUnmigratedTestDb();
    await migrate(db);
    await expect(migrate(db)).resolves.not.toThrow();
    expect(await isSchemaApplied(db)).toBe(true);
  });
});
