import { PGlite } from "@electric-sql/pglite";
import { afterAll } from "vitest";
import type { Db } from "../../src/adapters/db/Db";
import { applySchema, TABLE_NAMES } from "../../src/adapters/db/schema";

/**
 * Thrown by a pooled `Db` once its owning `createTestDb()` call has been `close()`d. A vitest test
 * that hits `testTimeout` is reported as failed, but its own `async` body is never actually
 * cancelled — nothing stops it from continuing to run (and to call `store.upsert()` etc. again)
 * after vitest has moved on to `afterEach` and the next test. Without this guard, that leftover
 * work would keep issuing real queries against the *same physical* PGlite engine after `release()`
 * (below) has already truncated it and handed it to a different, unrelated `createTestDb()` caller
 * — corrupting that caller's data, through a reference the leftover work already held. See `guard`
 * in `wrap()`.
 *
 * This is not the *only* way a timed-out test's leftover work can reach another test's database,
 * just the only one this module can close by itself: if a test file keeps its `Db` in a
 * module-level `let` that a later test reassigns (rather than a `const` local to each `it()`), a
 * still-running previous test can read that binding *after* the reassignment and hand a live,
 * not-yet-closed `Db` straight to `new Pg*Store(...)` — no stale reference involved, so this guard
 * never enters into it. `tests/app/stateRoundTrip.test.ts` had exactly that shape (it is the only
 * file that ever holds two `createTestDb()` results live at once) and was fixed to give each `it()`
 * its own `const` bindings instead — see that file's comment.
 */
class ClosedTestDbError extends Error {
  constructor() {
    super("createTestDb(): query issued after close() — a caller kept a stale Db reference (e.g. a timed-out test's leftover async work)");
    this.name = "ClosedTestDbError";
  }
}

/**
 * Wraps a PGlite instance as a `Db`. `inTransaction` is closed over so a `tx()` call issued from
 * inside an already-open transaction just runs `fn` against the same binding instead of nesting a
 * second `BEGIN` — "nested calls join the same transaction".
 *
 * `guard` is shared by every `Db` this call (and its nested `tx()` callbacks) produces. Every path
 * that reaches the client goes through `run()`, which checks `guard.closed` *synchronously*, before
 * ever calling `client.query()`. That is what makes `release()`'s cleanup below race-proof: once it
 * sets `guard.closed = true`, no *new* query from this `Db` can reach the engine, no matter how
 * much of the caller's own code still has to run — it throws `ClosedTestDbError` immediately
 * instead. A query already past that check (mid-flight when `close()` was called) still completes,
 * but PGlite serializes every `client.query()` call through its own internal mutex in submission
 * order, so it is guaranteed to finish before `release()`'s own truncate — which is why `release()`
 * only needs to run *after* setting the flag, not to wait for some separate drain step.
 */
function wrap(client: PGlite, inTransaction: boolean, guard: { closed: boolean }): Db {
  function run<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> {
    if (guard.closed) throw new ClosedTestDbError();
    return client.query<R>(sql, params);
  }
  return {
    async query<R>(sql: string, params?: unknown[]): Promise<R[]> {
      const result = await run<R>(sql, params);
      return result.rows;
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTransaction) return fn(wrap(client, true, guard));
      await run("begin");
      try {
        const result = await fn(wrap(client, true, guard));
        await run("commit");
        return result;
      } catch (err) {
        // A `ClosedTestDbError` from inside `fn` means `release()` already owns cleanup for this
        // engine (it runs its own `rollback` before truncating — see below); issuing a second,
        // unguarded `rollback` here from a call that outlived its `close()` would race that cleanup
        // on the same connection. Any other error is a real failure mid-transaction, which still
        // needs the rollback it always got.
        if (!(err instanceof ClosedTestDbError)) await client.query("rollback");
        throw err;
      }
    },
  };
}

/**
 * `createTestDb()` pools schema-applied PGlite engines rather than booting a new one per call.
 * Measured cost: `new PGlite()` itself is sub-millisecond, but the *first* query against a fresh
 * instance pays PGlite's one-time WASM Postgres bootstrap — ~2.1-2.7s, regardless of how trivial
 * that first query is. `TRUNCATE ... RESTART IDENTITY` plus re-running `applySchema` (idempotent —
 * see its own comment) against an *already-booted* instance costs ~20-55ms. Reusing engines turns
 * most of the suite's 200+ `createTestDb()` calls into that cheap path instead of the expensive one.
 *
 * `idle` holds engines a `close()` has returned, ready to be handed out again; `checkedOut` is only
 * for the shutdown sweep below. Each test file gets its own copies of both (Vitest's default
 * `isolate: true` gives every test file a fresh module registry), so this pool is scoped per file,
 * never shared across files — no explicit "reset between files" step is needed.
 *
 * A pooled engine is exactly as isolated as a freshly booted one: `release()` truncates every table
 * `applySchema` creates (`RESTART IDENTITY` resets each table's own `ordinal` sequence back to 1,
 * the same starting point a brand-new database has) and then re-applies the schema, which reseeds
 * `auth_attempts`' singleton row the truncate just removed. Nothing here weakens isolation between
 * `createTestDb()` calls; it only skips redoing the WASM bootstrap `applySchema` no longer needs.
 *
 * The pool grows to cover concurrent callers rather than forcing them to share one engine: two
 * `createTestDb()` calls live at once (`tests/app/stateRoundTrip.test.ts`'s `source`/`restored`)
 * each get their own physical PGlite instance, same as before — PGlite is single-connection, so one
 * engine backing two logically-independent `Db`s at once would let one's `tx()` and the other's
 * plain queries interleave on the same session. Pooling only collapses *sequential* reuse within a
 * file, which is what the other ~199 calls are.
 */
const idle: PGlite[] = [];
const checkedOut = new Set<PGlite>();

afterAll(async () => {
  const clients = [...idle, ...checkedOut];
  idle.length = 0;
  checkedOut.clear();
  await Promise.all(clients.map((client) => client.close()));
});

async function acquireMigrated(): Promise<PGlite> {
  const reused = idle.pop();
  if (reused) {
    checkedOut.add(reused);
    return reused;
  }
  const client = new PGlite();
  await applySchema(wrap(client, false, { closed: false }));
  checkedOut.add(client);
  return client;
}

/**
 * Returns a checked-out engine to the pool, indistinguishable from a freshly booted one. `rollback`
 * runs first and unconditionally — a no-op if nothing is open, but it closes out a transaction a
 * `close()`d `tx()` call had to abandon mid-flight (see the `ClosedTestDbError` branch in `wrap()`)
 * before the `truncate` below runs. Ordering these as two `await`s in the same function, on the
 * same client, is what pins them to that order: PGlite serializes `client.query()` calls in
 * submission order, and nothing else can submit one in between — see `wrap()`'s `guard` comment for
 * why the caller this engine came from cannot slip in a query after this point.
 */
async function releaseMigrated(client: PGlite, guard: { closed: boolean }): Promise<void> {
  guard.closed = true;
  checkedOut.delete(client);
  await client.query("rollback");
  await client.query(`truncate table ${TABLE_NAMES.join(", ")} restart identity`);
  await applySchema(wrap(client, false, { closed: false }));
  idle.push(client);
}

/** A schema-applied PGlite database with nothing in it. Call `close()` when done. */
export async function createTestDb(): Promise<Db & { close(): Promise<void> }> {
  const client = await acquireMigrated();
  const guard = { closed: false };
  const db = wrap(client, false, guard);
  return { ...db, close: () => releaseMigrated(client, guard) };
}

/**
 * A fresh in-memory PGlite database with **no** schema applied — deliberately, unlike
 * `createTestDb()`. This is what `output/`'s "nothing creates the tables, and `doctor` cannot
 * tell" hazard looks like on a real connection: exists for tests that must prove behaviour against
 * a database that has never seen `applySchema` (`db:import`'s own implicit call, and `doctor`'s
 * connectivity probe), not the one every other test wants. Call `close()` when done.
 *
 * Deliberately not pooled like `createTestDb()`: the whole point of this database is that nothing
 * has run DDL against it yet, and at least one caller (`tests/cli/dbImport.test.ts`'s "creates the
 * schema itself" case) runs code that applies the schema as a side effect. Reusing that engine for
 * the next `createUnmigratedTestDb()` call would hand back a database that is no longer unmigrated —
 * exactly the state this function exists to rule out. It is called a handful of times across the
 * suite, not hundreds, so it does not need the pool's speedup.
 */
export async function createUnmigratedTestDb(): Promise<Db & { close(): Promise<void> }> {
  const client = new PGlite();
  const db = wrap(client, false, { closed: false });
  return { ...db, close: () => client.close() };
}
