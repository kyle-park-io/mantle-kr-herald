import { Pool, type PoolClient } from "pg";
import type { Db } from "./Db";
import type { DbConfig } from "../../config";
import { tryDescribeDbTarget, INVALID_DB_URL } from "../../config";

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
 *
 * Exported (only) so `tests/adapters/db/createDb.test.ts` can drive it with an instrumented
 * `Pool` stand-in and assert which client each statement landed on — PGlite has exactly one
 * connection, so it cannot exercise the routing this function exists to get right.
 */
export function wrapPool(pool: Pool): Db {
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

/**
 * Error codes meaning "never reached a Postgres server" — as opposed to reaching one and being
 * told no. Only these get the target attached, because only for these is "is it running, and is
 * `DATABASE_URL` pointing where you meant?" the right next question. A `42P01`
 * (`relation ... does not exist`) dressed up as a connection problem would send an operator to
 * check Docker when the actual remedy is `pnpm db:migrate` — over-wrapping costs more than it saves.
 */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Attaches the database this `Db` was pointed at to any error that means it could not be reached.
 *
 * `pg` reports an unreachable server as `connect ECONNREFUSED 127.0.0.1:5432` and nothing more —
 * an address, with no indication of *which* of this project's databases was meant. That matters
 * here specifically: the same commands run against a local Postgres and against Neon, differing
 * only in which env file was loaded (`.env` vs `~/.herald/prod.env`), so an address alone cannot
 * tell an operator whether they hit the wrong target or the right target is down. Every CLI that
 * names its database on a startup line does so precisely because that ambiguity is real — but a
 * command that dies *while connecting* never reaches its own startup line, which is exactly when
 * the answer is most needed.
 *
 * Applied here, at the single construction site every CLI goes through, rather than in each
 * caller's error handling — a second place to decide what a connection failure means is a second
 * place for the two to disagree.
 *
 * Uses `tryDescribeDbTarget`, never `describeDbTarget`: this runs *while already reporting an
 * error*, and a reporter that throws its own error buries the original. Same reason
 * `watchStartupLine` uses it.
 */
export function withDbTarget(cfg: DbConfig, db: Db): Db {
  const enrich = (err: unknown): unknown => {
    const code = (err as { code?: unknown })?.code;
    if (typeof code !== "string" || !UNREACHABLE_CODES.has(code)) return err;
    const target = tryDescribeDbTarget(cfg) ?? INVALID_DB_URL;
    const original = err instanceof Error ? err.message : String(err);
    return new Error(
      `cannot reach the ${cfg.env} database at ${target} — ${original}. ` +
        `Check that database is running, and that DATABASE_URL points where you mean ` +
        `(this project's production DSN lives outside .env).`,
      { cause: err },
    );
  };

  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      try {
        return await db.query<R>(sql, params);
      } catch (err) {
        throw enrich(err);
      }
    },
    async tx<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      try {
        return await db.tx(fn);
      } catch (err) {
        throw enrich(err);
      }
    },
  };
}

/** A `Db` backed by a real Postgres `pg.Pool`. Construction only — no schema, no store logic.
 *  Call `close()` to drain the pool (e.g. at process shutdown or test teardown). */
export function createDb(cfg: DbConfig): Db & { close(): Promise<void> } {
  const pool = new Pool({ connectionString: cfg.url });
  const db = withDbTarget(cfg, wrapPool(pool));
  return { ...db, close: () => pool.end() };
}
