import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgAttemptLimiter, ipRowId } from "../../../src/adapters/store/PgAttemptLimiter";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const t = (ms: number) => new Date(1_800_000_000_000 + ms);

describe("PgAttemptLimiter", () => {
  it("allows attempts until the failure count trips the lockout", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 3, lockoutMs: 60_000 });
    expect(await limiter.retryAfterMs(t(0))).toBe(0);
    await limiter.recordFailure(t(0));
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBe(0);
    await limiter.recordFailure(t(2));
    expect(await limiter.retryAfterMs(t(3))).toBeGreaterThan(0);
  });

  it("shares state across instances — the whole point of moving it off the process", async () => {
    db = await createTestDb();
    const a = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    const b = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await a.recordFailure(t(0));
    await b.recordFailure(t(1));
    expect(await a.retryAfterMs(t(2))).toBeGreaterThan(0);
  });

  it("serving the lockout buys back the whole allowance", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await limiter.recordFailure(t(0));
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBeGreaterThan(0);
    expect(await limiter.retryAfterMs(t(70_000))).toBe(0);
    await limiter.recordFailure(t(70_001));
    expect(await limiter.retryAfterMs(t(70_002))).toBe(0);
  });

  it("a success clears the count", async () => {
    db = await createTestDb();
    const limiter = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    await limiter.recordFailure(t(0));
    await limiter.recordSuccess();
    await limiter.recordFailure(t(1));
    expect(await limiter.retryAfterMs(t(2))).toBe(0);
  });

  /**
   * The two-layer design (`attemptLimiter.ts`'s doc comment) depends on the global row ('singleton',
   * the default `id`) and a per-IP row (`ipRowId(...)`) never sharing state — otherwise a per-IP
   * failure would also count against the global backstop's own row and the two would not be
   * independent counters at all, just one counter under two names.
   */
  it("keys failures per id — a per-IP row and the global row do not share state", async () => {
    db = await createTestDb();
    const global = new PgAttemptLimiter(db, { maxFailures: 2, lockoutMs: 60_000 });
    const perIp = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 2, lockoutMs: 60_000 });
    await perIp.recordFailure(t(0));
    expect(await global.retryAfterMs(t(1))).toBe(0);
    await perIp.recordFailure(t(1));
    expect(await perIp.retryAfterMs(t(2))).toBeGreaterThan(0);
    expect(await global.retryAfterMs(t(2))).toBe(0);
  });

  /** Two distinct per-IP ids are just as independent from each other as either is from the global row. */
  it("keeps two different per-IP rows independent from each other", async () => {
    db = await createTestDb();
    const a = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 2, lockoutMs: 60_000 });
    const b = new PgAttemptLimiter(db, { id: ipRowId("198.51.100.7"), maxFailures: 2, lockoutMs: 60_000 });
    await a.recordFailure(t(0));
    await a.recordFailure(t(1));
    expect(await a.retryAfterMs(t(2))).toBeGreaterThan(0);
    expect(await b.retryAfterMs(t(2))).toBe(0);
  });

  describe("per-IP row eviction", () => {
    /**
     * `PER_IP_ROW_RETENTION_MS` is an hour (see its own comment); a row untouched for barely over
     * that long is what the sweep exists to remove — an attacker (or ordinary address churn) that
     * touched one address once and never came back would otherwise leave that row forever.
     */
    it("sweeps a per-IP row that has gone stale, on the next per-IP write from any address", async () => {
      db = await createTestDb();
      const stale = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await stale.recordFailure(t(0));
      expect(await stale.retryAfterMs(t(1))).toBe(0); // one failure, well under maxFailures — no lockout, just a row

      // A different address's failure, over an hour later, is what runs the sweep.
      const other = new PgAttemptLimiter(db, { id: ipRowId("198.51.100.7"), maxFailures: 5, lockoutMs: 60_000 });
      await other.recordFailure(t(60 * 60 * 1000 + 1));

      const rows = await db.query<{ id: string }>(`select id from auth_attempts where id like 'ip:%'`);
      expect(rows.map((r) => r.id).sort()).toEqual([ipRowId("198.51.100.7")]); // the stale row is gone, the fresh one is not
    });

    it("does not sweep a per-IP row that is merely old but still within the retention window", async () => {
      db = await createTestDb();
      const recent = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await recent.recordFailure(t(0));

      const other = new PgAttemptLimiter(db, { id: ipRowId("198.51.100.7"), maxFailures: 5, lockoutMs: 60_000 });
      await other.recordFailure(t(60 * 60 * 1000 - 1)); // just under an hour later

      const rows = await db.query<{ id: string }>(`select id from auth_attempts where id like 'ip:%'`);
      expect(rows.map((r) => r.id).sort()).toEqual([ipRowId("198.51.100.7"), ipRowId("203.0.113.9")].sort());
    });

    /** The global row is never a `ip:%` row, so the sweep — which only ever matches that prefix — must never touch it, however stale. */
    it("never sweeps the global row, no matter how stale", async () => {
      db = await createTestDb();
      const global = new PgAttemptLimiter(db, { maxFailures: 5, lockoutMs: 60_000 });
      await global.recordFailure(t(0));

      const perIp = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await perIp.recordFailure(t(10 * 60 * 60 * 1000)); // ten hours later — many retention windows past

      const rows = await db.query<{ id: string }>(`select id from auth_attempts where id = 'singleton'`);
      expect(rows).toHaveLength(1);
    });

    /**
     * A row's own `last_attempt_at` is refreshed before the sweep runs (`recordFailure`'s upsert
     * happens first), so a call recording ANOTHER failure against a row it had let go stale never
     * evicts-and-recreates its own row — the count accumulates (2, here), rather than resetting to 1
     * as it would if the row had actually been deleted and the insert-on-conflict-do-nothing had
     * created a fresh one in its place.
     */
    it("accumulates a per-IP row's own count across a gap wider than the retention window, rather than resetting it", async () => {
      db = await createTestDb();
      const limiter = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await limiter.recordFailure(t(0));
      await limiter.recordFailure(t(10 * 60 * 60 * 1000)); // ten hours later, from the SAME id
      const rows = await db.query<{ failures: number }>(`select failures from auth_attempts where id = $1`, [ipRowId("203.0.113.9")]);
      expect(rows[0].failures).toBe(2);
    });
  });
});
