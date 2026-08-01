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
     * evicts-and-recreates its own row via the sweep — `id <> $2` in the sweep's own `delete` excludes
     * it. What decides the resulting count is the decay rule below, not eviction: a gap this wide
     * (ten hours) is far past `lockoutMs`, so decay resets the count to 1 — the same number a genuine
     * evict-and-recreate would have produced, which is exactly why decay, not eviction-avoidance, is
     * what a caller actually observes here.
     */
    it("does not evict-and-recreate a per-IP row's own count across a gap wider than the retention window", async () => {
      db = await createTestDb();
      const limiter = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await limiter.recordFailure(t(0));
      await limiter.recordFailure(t(10 * 60 * 60 * 1000)); // ten hours later, from the SAME id
      const rows = await db.query<{ failures: number }>(`select failures from auth_attempts where id = $1`, [ipRowId("203.0.113.9")]);
      expect(rows[0].failures).toBe(1);
    });

    /**
     * `recordSuccess` is a row-creating write too — its `insert ... on conflict do update` makes a
     * fresh `ip:<address>` row exactly like a failure would when the address has never been seen
     * before (a first-ever login attempt from a new address that happens to be correct). An install
     * where every login succeeds would otherwise accumulate one such row per distinct client forever.
     */
    it("recordSuccess creates a per-IP row even for an address that never recorded a failure", async () => {
      db = await createTestDb();
      const limiter = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await limiter.recordSuccess();
      const rows = await db.query<{ id: string }>(`select id from auth_attempts where id = $1`, [ipRowId("203.0.113.9")]);
      expect(rows).toHaveLength(1);
    });

    /**
     * `recordSuccess` has no `now` parameter (unlike `recordFailure`/`retryAfterMs`), so this test
     * anchors "stale" to the real clock rather than the fixed `t(...)` base the rest of this file
     * uses — a comfortable margin (5s) past the one-hour retention window absorbs however long the
     * test itself takes to run.
     */
    it("recordSuccess sweeps stale per-IP rows too, not only recordFailure", async () => {
      db = await createTestDb();
      const staleAt = new Date(Date.now() - (60 * 60 * 1000 + 5_000));
      const stale = new PgAttemptLimiter(db, { id: ipRowId("203.0.113.9"), maxFailures: 5, lockoutMs: 60_000 });
      await stale.recordFailure(staleAt);

      const other = new PgAttemptLimiter(db, { id: ipRowId("198.51.100.7"), maxFailures: 5, lockoutMs: 60_000 });
      await other.recordSuccess();

      const rows = await db.query<{ id: string }>(`select id from auth_attempts where id like 'ip:%'`);
      expect(rows.map((r) => r.id)).toEqual([ipRowId("198.51.100.7")]);
    });
  });

  /**
   * The decay this review asked for: without it, `failures` is "since the last success or the last
   * served lockout", unbounded in wall-clock time — a single address can fail just under
   * `maxFailures`, sit out its own lockout window, and repeat forever, with the GLOBAL row (every
   * attempt counts against it, whatever the source) accumulating toward ITS OWN lockout across that
   * unbounded time and eventually locking out the whole team from one address alone. Decaying the
   * count whenever the gap since the last attempt exceeds `lockoutMs` closes that: by the time any one
   * address's own lockout has lapsed and it resumes, the gap is always past `lockoutMs`, so nothing it
   * contributed before the wait carries into what comes after.
   */
  describe("failure-count decay", () => {
    it("resets the count when the gap since the last attempt exceeds lockoutMs, even under the failure threshold", async () => {
      db = await createTestDb();
      const limiter = new PgAttemptLimiter(db, { maxFailures: 10, lockoutMs: 60_000 });
      await limiter.recordFailure(t(0));
      await limiter.recordFailure(t(1));
      await limiter.recordFailure(t(2)); // 3 failures, nowhere near the threshold — no lockout ever set
      await limiter.recordFailure(t(60_000 + 3)); // just over a minute later
      const rows = await db.query<{ failures: number }>(`select failures from auth_attempts where id = 'singleton'`);
      expect(rows[0].failures).toBe(1); // decayed, not 4
    });

    it("does not reset the count when the gap since the last attempt is within lockoutMs", async () => {
      db = await createTestDb();
      const limiter = new PgAttemptLimiter(db, { maxFailures: 10, lockoutMs: 60_000 });
      await limiter.recordFailure(t(0));
      await limiter.recordFailure(t(1));
      await limiter.recordFailure(t(59_999)); // just under a minute after the first — no decay
      const rows = await db.query<{ failures: number }>(`select failures from auth_attempts where id = 'singleton'`);
      expect(rows[0].failures).toBe(3);
    });

    /**
     * The concrete exploit this closes: one address grinds a burst of `maxFailures - 1` failures
     * (never tripping its OWN per-IP lockout), waits just past its own decay window, and repeats.
     * Without decay the GLOBAL row — which every attempt counts against regardless of source —
     * accumulates without bound across those waits; with it, each burst's contribution to the global
     * count evaporates before the next one starts, so repeating the cycle any number of times never
     * gets the global row any closer to ITS OWN (much higher) threshold than a single burst did.
     */
    it("keeps a repeated below-threshold-then-wait cycle from ever accumulating toward the global lockout", async () => {
      db = await createTestDb();
      const global = new PgAttemptLimiter(db, { maxFailures: 50, lockoutMs: 60_000 });
      for (let cycle = 0; cycle < 6; cycle++) {
        const base = cycle * 2 * 60_000; // each cycle starts well past the previous one's decay window
        for (let i = 0; i < 4; i++) {
          await global.recordFailure(t(base + i)); // 4 failures per cycle, 24 total across 6 cycles
        }
      }
      expect(await global.retryAfterMs(t(6 * 2 * 60_000))).toBe(0); // still nowhere near 50 — never locked
    });
  });
});
