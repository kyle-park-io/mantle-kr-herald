import { Pool, type PoolClient } from "pg";
import type { Db } from "./Db";
import type { DbConfig } from "../../config";

/**
 * Wraps a single pinned connection (a transaction in progress) as a `Db`. `inTransaction` is
 * closed over so a `tx()` call issued from inside an already-open transaction just runs `fn`
 * against the same client instead of nesting a second `BEGIN` — "nested calls join the same
 * transaction", matching `tests/support/testDb.ts`.
 */
function wrapClient(client: PoolClient, inTransaction: boolean): Db {
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      const result = await client.query(sql, params);
      return result.rows as R[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(wrapClient(client, true));
      await client.query("begin");
      try {
        const result = await fn(wrapClient(client, true));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      }
    },
  };
}

/**
 * Wraps a `pg.Pool` as a `Db`. A pool has no fixed connection: `query()` borrows whatever
 * connection is free and returns it when done, which is fine for a single statement but wrong
 * for a transaction — `BEGIN` on one connection and the next statement landing on another would
 * run outside it silently, committing nothing and rolling back nothing. So `tx()` here does not
 * reuse `query()`: it calls `pool.connect()` to pin one client for the whole callback, runs
 * `BEGIN`/`COMMIT`/`ROLLBACK` on that same client via `wrapClient`, and releases it in `finally`
 * so a thrown `BEGIN`/`COMMIT`/callback error still returns the client to the pool.
 */
function wrapPool(pool: Pool): Db {
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      const result = await pool.query(sql, params);
      return result.rows as R[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await wrapClient(client, false).tx(fn);
      } finally {
        client.release();
      }
    },
  };
}

/** A `Db` backed by a real Postgres `pg.Pool`. Construction only — no schema, no store logic.
 *  Call `close()` to drain the pool (e.g. at process shutdown or test teardown). */
export function createDb(cfg: DbConfig): Db & { close(): Promise<void> } {
  const pool = new Pool({ connectionString: cfg.url });
  const db = wrapPool(pool);
  return { ...db, close: () => pool.end() };
}
