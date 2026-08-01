import { describe, it, expect, beforeAll } from "vitest";
import { Login } from "../../src/app/Login";
import { hashPassword } from "../../src/domain/auth/password";
import { createAttemptLimiter } from "../../src/domain/auth/attemptLimiter";

const at = (ms: number) => new Date(ms);
const GOOD = { username: "herald", password: "open sesame" };

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(GOOD.password);
});

/** A fresh use case per test — the limiter carries state deliberately. */
function login(maxFailures = 3) {
  return new Login(
    { username: GOOD.username, passwordHash },
    createAttemptLimiter({ maxFailures, lockoutMs: 60_000 }),
  );
}

describe("Login", () => {
  it("accepts the configured credentials", async () => {
    expect(await login().run(GOOD, at(0))).toEqual({ ok: true });
  });

  it("refuses the wrong password, with nothing to wait for yet", async () => {
    expect(await login().run({ ...GOOD, password: "nope" }, at(0))).toEqual({ ok: false, retryAfterMs: 0 });
  });

  it("locks out once the failures run out", async () => {
    const use = login(3);
    for (let i = 0; i < 3; i++) await use.run({ ...GOOD, password: "nope" }, at(0));
    expect(await use.run({ ...GOOD, password: "nope" }, at(0))).toEqual({ ok: false, retryAfterMs: 60_000 });
  });

  /**
   * The point of the lockout: while it holds, the right password is refused too. If a correct
   * credential still got in, an attacker who guesses it during the window walks straight past the
   * limiter, and the throttle protects nothing.
   */
  it("refuses even the correct credentials while locked out", async () => {
    const use = login(3);
    for (let i = 0; i < 3; i++) await use.run({ ...GOOD, password: "nope" }, at(0));
    expect(await use.run(GOOD, at(0))).toEqual({ ok: false, retryAfterMs: 60_000 });
  });

  /**
   * `serve.ts` now refuses to start at all without an account configured (the dashboard is no longer
   * loopback-only) — this test is `Login`'s own fallback for any other caller that constructs it
   * unconfigured anyway: refuse every attempt rather than throw, since there is nothing to let anyone
   * in to yet.
   */
  it("refuses every attempt when no account is configured", async () => {
    const use = new Login(undefined, createAttemptLimiter());
    expect(await use.run(GOOD, at(0))).toEqual({ ok: false, retryAfterMs: 0 });
  });

  it("clears the failure count on a success", async () => {
    const use = login(3);
    await use.run({ ...GOOD, password: "nope" }, at(0));
    await use.run({ ...GOOD, password: "nope" }, at(0));
    await use.run(GOOD, at(0));
    expect(await use.run({ ...GOOD, password: "nope" }, at(0))).toEqual({ ok: false, retryAfterMs: 0 });
  });

  /**
   * The two-layer design (`attemptLimiter.ts`'s doc comment): `run`'s optional third argument is the
   * per-IP counter, the global (constructor) `limiter` stays fixed. A login is refused if EITHER says
   * so — these tests exercise that from `Login`'s own perspective, decoupled from which concrete
   * `AttemptLimiter` (`createAttemptLimiter` here, `PgAttemptLimiter` for real) backs either layer.
   */
  describe("the per-IP layer (run's optional ipLimiter)", () => {
    it("refuses once the PER-IP layer alone trips, even though the global layer has room left", async () => {
      const ipLimiter = createAttemptLimiter({ maxFailures: 1, lockoutMs: 60_000 });
      const use = login(100); // global threshold far from tripping
      // The single per-IP failure below already trips ITS lockout (maxFailures: 1) — `run` re-checks
      // after recording it, so this same call already reports the wait, not just the next one.
      expect(await use.run({ ...GOOD, password: "nope" }, at(0), ipLimiter)).toEqual({ ok: false, retryAfterMs: 60_000 });
      // The correct password is refused too, same as the existing "refuses even the correct
      // credentials while locked out" case — just from the per-IP layer this time, not the global one.
      expect(await use.run(GOOD, at(0), ipLimiter)).toEqual({ ok: false, retryAfterMs: 60_000 });
    });

    it("refuses once the GLOBAL layer alone trips, even though this request's per-IP layer has room left", async () => {
      const use = login(1); // global trips on the first failure
      const firstIp = createAttemptLimiter({ maxFailures: 100, lockoutMs: 60_000 });
      await use.run({ ...GOOD, password: "nope" }, at(0), firstIp);
      // A second address's own, untouched per-IP limiter — still refused, because the global layer
      // (shared account-wide) is what is actually locked.
      const secondIp = createAttemptLimiter({ maxFailures: 100, lockoutMs: 60_000 });
      expect(await use.run(GOOD, at(0), secondIp)).toEqual({ ok: false, retryAfterMs: 60_000 });
    });

    it("treats a missing ipLimiter as only the global layer having a vote, not an exemption from both", async () => {
      const use = login(1); // global trips on the first failure
      await use.run({ ...GOOD, password: "nope" }, at(0)); // no ipLimiter at all
      expect(await use.run(GOOD, at(0))).toEqual({ ok: false, retryAfterMs: 60_000 });
    });

    it("clears the per-IP layer's own count on a success, the same as the global layer", async () => {
      const ipLimiter = createAttemptLimiter({ maxFailures: 2, lockoutMs: 60_000 });
      const use = login(100);
      await use.run({ ...GOOD, password: "nope" }, at(0), ipLimiter);
      await use.run(GOOD, at(0), ipLimiter);
      expect(await use.run({ ...GOOD, password: "nope" }, at(0), ipLimiter)).toEqual({ ok: false, retryAfterMs: 0 });
    });
  });
});
