/**
 * Async because a database-backed limiter (`PgAttemptLimiter`) cannot answer synchronously — the
 * in-memory implementation below is the only one that could, and it resolves immediately.
 */
export interface AttemptLimiter {
  /** Milliseconds the caller must wait before trying again, or 0 when the attempt may proceed. */
  retryAfterMs(now: Date): Promise<number>;
  recordFailure(now: Date): Promise<void>;
  recordSuccess(): Promise<void>;
}

/**
 * Failed-login throttling for the dashboard's one account.
 *
 * One counter, not one per client: there is a single credential, so every attempt is an attempt on
 * the same thing and keying by IP would only tell an attacker to rotate addresses. The cost is that
 * a stranger guessing can lock the team out for `lockoutMs` — acceptable at this size, and the
 * reason the window is a minute rather than an hour. That tradeoff was first accepted back when the
 * only implementation was this one, in-memory one, so restarting the process was always the fallback
 * escape hatch even in the worst case. `PgAttemptLimiter` deliberately gave that up — the whole point
 * of moving the lockout into the database is that it survives a restart — so for whichever
 * implementation an install is actually running, do not assume a restart clears a lockout; see
 * `docs/ko/team-runbook.md`'s entry for a locked-out login for the real recovery.
 *
 * State is in memory, so it resets when the process does — a serverless deployment gets a fresh
 * limiter per instance and would need a shared store to be meaningful, which is what motivated
 * `PgAttemptLimiter` in the first place. `serve.ts`, the one composition root this project has, has
 * constructed a `PgAttemptLimiter` there ever since — not this function — so "adequate for a
 * long-lived server" is no longer a claim about anything actually running; nothing here reaches
 * production. What's left is `Login`'s own tests and its optional-`account` fallback caller (see
 * `Login`'s own comment for why that stays permissive) — a database-free `AttemptLimiter` for a
 * caller with no `Db` to hand it. See docs/superpowers/specs/2026-07-29-dashboard-auth-options.md.
 */
export function createAttemptLimiter(options: { maxFailures?: number; lockoutMs?: number } = {}): AttemptLimiter {
  const maxFailures = options.maxFailures ?? 5;
  const lockoutMs = options.lockoutMs ?? 60_000;
  let failures = 0;
  let lockedAt: Date | undefined;

  const remainingMs = (now: Date): number => {
    if (lockedAt === undefined) return 0;
    const remaining = lockoutMs - (now.getTime() - lockedAt.getTime());
    return remaining > 0 ? remaining : 0;
  };

  return {
    async retryAfterMs(now) {
      return remainingMs(now);
    },
    async recordFailure(now) {
      // Serving the lockout buys back the whole allowance. Without this the count carries over, so
      // the first typo after the wait re-locks immediately and the operator never gets back in.
      if (lockedAt !== undefined && remainingMs(now) === 0) {
        failures = 0;
        lockedAt = undefined;
      }
      failures += 1;
      if (failures >= maxFailures) lockedAt = now;
    },
    async recordSuccess() {
      failures = 0;
      lockedAt = undefined;
    },
  };
}
