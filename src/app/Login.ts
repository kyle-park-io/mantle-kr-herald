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
 */
export class Login {
  /**
   * `account` is optional because the dashboard has always run without one, bound to loopback.
   * Requiring it here would stop those installs at startup; an unconfigured server serves as before
   * and refuses every login, since there is nothing to let anyone in to yet.
   */
  constructor(
    private readonly account: Account | undefined,
    private readonly limiter: AttemptLimiter,
  ) {}

  async run(supplied: SuppliedCredentials, now: Date): Promise<LoginResult> {
    const retryAfterMs = this.limiter.retryAfterMs(now);
    if (retryAfterMs > 0) return { ok: false, retryAfterMs };
    if (this.account === undefined) return { ok: false, retryAfterMs: 0 };

    if (await checkCredentials(supplied, this.account)) {
      this.limiter.recordSuccess();
      return { ok: true };
    }
    this.limiter.recordFailure(now);
    // Read the lockout again: this failure may have been the one that tripped it, and the caller
    // should be told to wait now rather than discover it on the next attempt.
    return { ok: false, retryAfterMs: this.limiter.retryAfterMs(now) };
  }
}
