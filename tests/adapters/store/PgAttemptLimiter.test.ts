import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgAttemptLimiter } from "../../../src/adapters/store/PgAttemptLimiter";

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
});
