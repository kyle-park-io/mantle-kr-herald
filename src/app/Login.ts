import type { AttemptLimiter } from "../domain/auth/attemptLimiter";
import { checkCredentials, type Account, type SuppliedCredentials } from "../domain/auth/credentials";

/** `retryAfterMs` is 0 for a plain refusal and positive while the lockout holds. */
export type LoginResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Checks the dashboard's one credential, behind a failed-attempt lockout.
 *
 * The lockout is consulted first and refuses without checking anything — that is what makes it a
 * throttle. Letting a correct password through during the window would hand a guesser the account
 * the moment they found it, however many refusals came before.
 *
 * `run`'s optional `ipLimiter` is the per-IP half of the two-layer design `attemptLimiter.ts`'s own
 * comment explains — the constructor-supplied `limiter` is always the global backstop, fixed for the
 * lifetime of this `Login`, while a per-IP limiter is a fresh `PgAttemptLimiter` built per REQUEST
 * (its row key depends on that request's client address, `Login` has no address of its own to fix
 * one at construction time) — see `serve.ts`'s composition of `deps.login`. A login is refused if
 * either layer says so; `undefined` — no trustworthy IP for this request (`clientIp.ts`'s
 * `resolveClientIp`) — simply means only the global layer gets a vote, not that the request is
 * exempt from both.
 */
export class Login {
  /**
   * `account` stays optional at this layer even though `serve.ts` now refuses to start the dashboard
   * without one (see its own comment) — that used to be the reason: the server ran loopback-only, so
   * an unconfigured account was harmless, and `Login` simply refused every attempt. The refusal
   * belongs to whoever wires this up, not to the credential check itself, so `Login` keeps behaving
   * safely (refuse everything) for any other caller that constructs it unconfigured — a test, or some
   * future embedding — rather than throwing over a decision it does not own.
   */
  constructor(
    private readonly account: Account | undefined,
    private readonly limiter: AttemptLimiter,
  ) {}

  async run(supplied: SuppliedCredentials, now: Date, ipLimiter?: AttemptLimiter): Promise<LoginResult> {
    const retryAfterMs = await this.waitFor(now, ipLimiter);
    if (retryAfterMs > 0) return { ok: false, retryAfterMs };
    if (this.account === undefined) return { ok: false, retryAfterMs: 0 };

    if (await checkCredentials(supplied, this.account)) {
      await this.limiter.recordSuccess();
      if (ipLimiter) await ipLimiter.recordSuccess();
      return { ok: true };
    }
    await this.limiter.recordFailure(now);
    if (ipLimiter) await ipLimiter.recordFailure(now);
    // Read the lockout again: this failure may have been the one that tripped it (on either layer),
    // and the caller should be told to wait now rather than discover it on the next attempt.
    return { ok: false, retryAfterMs: await this.waitFor(now, ipLimiter) };
  }

  /** The longer of the two layers' waits — refused if EITHER says so, not only the global one. */
  private async waitFor(now: Date, ipLimiter?: AttemptLimiter): Promise<number> {
    const global = await this.limiter.retryAfterMs(now);
    const perIp = ipLimiter ? await ipLimiter.retryAfterMs(now) : 0;
    return Math.max(global, perIp);
  }
}
