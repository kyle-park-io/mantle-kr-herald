/**
 * The one query interface every `Pg*` store depends on. A store only ever imports this type —
 * never `pg` or `@electric-sql/pglite` directly — so the same store runs unchanged against a real
 * Postgres (`createDb.ts`) and an in-memory PGlite instance (`tests/support/testDb.ts`).
 */
export interface Db {
  /** Runs one statement. Rows come back as plain objects, keyed by column name. */
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  /**
   * Runs `fn` inside `BEGIN`/`COMMIT`, rolling back on throw. The `Db` passed to `fn` is bound to
   * the same connection, so a `query` issued from inside `fn` joins the transaction, and a nested
   * `tx()` call joins it too rather than opening a second one.
   */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}
