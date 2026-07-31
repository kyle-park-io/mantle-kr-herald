import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../../src/adapters/db/Db";
import { applySchema } from "../../src/adapters/db/schema";

/**
 * Wraps a PGlite instance as a `Db`. `inTransaction` is closed over so a `tx()` call issued from
 * inside an already-open transaction just runs `fn` against the same binding instead of nesting a
 * second `BEGIN` — "nested calls join the same transaction".
 */
function wrap(client: PGlite, inTransaction: boolean): Db {
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      const result = await client.query<R>(sql, params);
      return result.rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(wrap(client, true));
      await client.query("begin");
      try {
        const result = await fn(wrap(client, true));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    },
  };
}

/** A fresh in-memory PGlite database with the schema already applied. Call `close()` when done. */
export async function createTestDb(): Promise<Db & { close(): Promise<void> }> {
  const client = new PGlite();
  const db = wrap(client, false);
  await applySchema(db);
  return { ...db, close: () => client.close() };
}

/**
 * A fresh in-memory PGlite database with **no** schema applied — deliberately, unlike
 * `createTestDb()`. This is what `output/`'s "nothing creates the tables, and `doctor` cannot
 * tell" hazard looks like on a real connection: exists for tests that must prove behaviour against
 * a database that has never seen `applySchema` (`db:import`'s own implicit call, and `doctor`'s
 * connectivity probe), not the one every other test wants. Call `close()` when done.
 */
export async function createUnmigratedTestDb(): Promise<Db & { close(): Promise<void> }> {
  const client = new PGlite();
  const db = wrap(client, false);
  return { ...db, close: () => client.close() };
}
