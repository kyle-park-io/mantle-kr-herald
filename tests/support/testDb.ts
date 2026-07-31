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
