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
});
