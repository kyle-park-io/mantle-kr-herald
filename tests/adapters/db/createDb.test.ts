import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { wrapPool } from "../../../src/adapters/db/createDb";

/**
 * These tests stand a hand-rolled `Pool`-shaped fake in for a real Postgres connection. That is
 * not a violation of this plan's "tests use a real Postgres, never a mock" constraint
 * (docs/superpowers/plans/2026-07-31-hosted-writes-a-storage.md): that constraint exists so no
 * test fakes *database behaviour* — what Postgres itself enforces (constraints, transaction
 * semantics, and so on). Nothing here asserts database behaviour. What is under test is which
 * *connection* each statement issued inside `wrapPool(pool).tx()` was routed to — a property of
 * this adapter's contract with `pg`, not of Postgres. PGlite, the harness every other test in this
 * repo uses (`tests/support/testDb.ts`), is a single-connection embedded engine with no pool: it
 * has no second connection for a bug to misroute a statement to, so it cannot express the failure
 * this file exists to catch — a `tx()` that silently splits `BEGIN`/statements/`COMMIT` across
 * different pooled connections, which commits nothing and rolls back nothing while looking fine.
 * An instrumented `Pool` fake that records which client each call landed on is the only way to
 * pin that down.
 */

interface FakeClient {
  id: string;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface FakePool {
  pool: Pool;
  log: string[];
  connect: ReturnType<typeof vi.fn>;
  poolQuery: ReturnType<typeof vi.fn>;
  clients: FakeClient[];
}

/** A `Pool` stand-in whose `connect()` hands out a fresh, distinguishable client each call — so
 *  if `tx()` ever called `connect()` more than once, or routed a statement through `pool.query()`
 *  instead of the pinned client, the log below would show it. */
function makeFakePool(): FakePool {
  const log: string[] = [];
  const clients: FakeClient[] = [];
  let nextId = 0;

  function makeClient(): FakeClient {
    const id = `client-${nextId++}`;
    const client: FakeClient = {
      id,
      query: vi.fn(async (sql: string) => {
        log.push(`${id}:${sql}`);
        return { rows: [] };
      }),
      release: vi.fn(() => {
        log.push(`${id}:release`);
      }),
    };
    clients.push(client);
    return client;
  }

  const connect = vi.fn(async () => makeClient());
  const poolQuery = vi.fn(async (sql: string) => {
    log.push(`pool:${sql}`);
    return { rows: [] };
  });

  return {
    pool: { query: poolQuery, connect } as unknown as Pool,
    log,
    connect,
    poolQuery,
    clients,
  };
}

describe("wrapPool(pool).tx()", () => {
  it("routes BEGIN, every statement, and COMMIT to one and the same pinned client, connecting once and releasing once", async () => {
    const { pool, log, connect, poolQuery, clients } = makeFakePool();
    const db = wrapPool(pool);

    const result = await db.tx(async (txDb) => {
      await txDb.query("select 1");
      await txDb.query("select 2");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled(); // nothing in the transaction went through the pool directly
    expect(clients).toHaveLength(1);

    const [client] = clients;
    expect(client.release).toHaveBeenCalledTimes(1);
    // Every statement — begin, both queries, commit — landed on the one pinned client, in order.
    // A regression to `pool.query()` for any of these would either move it to a `pool:`-prefixed
    // log entry or hand out a second client; either way this exact sequence would break.
    expect(log).toEqual([
      `${client.id}:begin`,
      `${client.id}:select 1`,
      `${client.id}:select 2`,
      `${client.id}:commit`,
      `${client.id}:release`,
    ]);
  });

  it("rolls back on that same client and still releases it exactly once when the callback throws, without ever committing", async () => {
    const { pool, log, connect, poolQuery, clients } = makeFakePool();
    const db = wrapPool(pool);

    await expect(
      db.tx(async (txDb) => {
        await txDb.query("select 1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(clients).toHaveLength(1);

    const [client] = clients;
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      `${client.id}:begin`,
      `${client.id}:select 1`,
      `${client.id}:rollback`,
      `${client.id}:release`,
    ]);
    expect(log).not.toContain(`${client.id}:commit`);
  });
});
