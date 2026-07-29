export interface AttemptLimiter {
  /** Milliseconds the caller must wait before trying again, or 0 when the attempt may proceed. */
  retryAfterMs(now: Date): number;
  recordFailure(now: Date): void;
  recordSuccess(): void;
}

/**
 * Failed-login throttling for the dashboard's one account.
 *
 * One counter, not one per client: there is a single credential, so every attempt is an attempt on
 * the same thing and keying by IP would only tell an attacker to rotate addresses. The cost is that
 * a stranger guessing can lock the team out for `lockoutMs` — acceptable at this size, and the
 * reason the window is a minute rather than an hour.
 *
 * State is in memory, so it resets when the process does. Adequate for a long-lived server; a
 * serverless deployment gets a fresh limiter per instance and would need a shared store to be
 * meaningful. See docs/superpowers/specs/2026-07-29-dashboard-auth-options.md.
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
    retryAfterMs: remainingMs,
    recordFailure(now) {
      // Serving the lockout buys back the whole allowance. Without this the count carries over, so
      // the first typo after the wait re-locks immediately and the operator never gets back in.
      if (lockedAt !== undefined && remainingMs(now) === 0) {
        failures = 0;
        lockedAt = undefined;
      }
      failures += 1;
      if (failures >= maxFailures) lockedAt = now;
    },
    recordSuccess() {
      failures = 0;
      lockedAt = undefined;
    },
  };
}
