import { describe, it, expect } from "vitest";
import { createAttemptLimiter } from "../../../src/domain/auth/attemptLimiter";

const at = (ms: number) => new Date(ms);

describe("attempt limiter", () => {
  it("lets an attempt through when nothing has failed", async () => {
    expect(await createAttemptLimiter().retryAfterMs(at(0))).toBe(0);
  });

  it("locks out once the failures run out", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 3, lockoutMs: 60_000 });
    for (let i = 0; i < 3; i++) await limiter.recordFailure(at(0));
    expect(await limiter.retryAfterMs(at(0))).toBe(60_000);
  });

  it("counts the lockout down as time passes", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 3, lockoutMs: 60_000 });
    for (let i = 0; i < 3; i++) await limiter.recordFailure(at(0));
    expect(await limiter.retryAfterMs(at(20_000))).toBe(40_000);
  });

  it("lets attempts through once the lockout has elapsed", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 3, lockoutMs: 60_000 });
    for (let i = 0; i < 3; i++) await limiter.recordFailure(at(0));
    expect(await limiter.retryAfterMs(at(60_000))).toBe(0);
  });

  /**
   * Serving the lockout has to buy back the whole allowance. Carrying the old count forward would
   * mean the single next typo re-locks for another full minute, and the operator who simply
   * fat-fingered their password is locked out indefinitely, a minute at a time.
   */
  it("restores the full allowance after a lockout is served", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 3, lockoutMs: 60_000 });
    for (let i = 0; i < 3; i++) await limiter.recordFailure(at(0));
    await limiter.recordFailure(at(60_000));
    expect(await limiter.retryAfterMs(at(60_000))).toBe(0);
  });

  it("clears the failures on a success", async () => {
    const limiter = createAttemptLimiter({ maxFailures: 3, lockoutMs: 60_000 });
    await limiter.recordFailure(at(0));
    await limiter.recordFailure(at(0));
    await limiter.recordSuccess();
    await limiter.recordFailure(at(0));
    expect(await limiter.retryAfterMs(at(0))).toBe(0);
  });
});
