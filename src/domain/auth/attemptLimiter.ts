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
 * `serve.ts` (the one composition root this project has) actually runs TWO of these, layered rather
 * than one replacing the other:
 *
 * 1. **A global counter**, one row for the whole account (`PgAttemptLimiter`'s `'singleton'` row) —
 *    every attempt counts against it, whatever its source. There is a single credential, so an
 *    attempt from anywhere is an attempt on the same thing, and this layer alone is what closes that
 *    gap. Its threshold is deliberately much higher than the per-IP one below (`serve.ts` picks the
 *    number and says why): it exists to catch a genuinely distributed attack — many addresses, each
 *    staying under its own per-IP limit — not an ordinary team's occasional mistyped password.
 * 2. **A per-IP counter**, one row per client address (`PgAttemptLimiter`'s `ip:<address>` rows,
 *    built fresh per request by `serve.ts` from whatever `resolveClientIp` — `clientIp.ts` — could
 *    trust) — kept at today's original threshold. This is what stops a single stranger (or a single
 *    teammate's typo) from locking out everyone else: without it, the global counter alone is what
 *    used to make one wrong guess from anywhere cost the whole team a minute, indefinitely, for
 *    free.
 *
 * A login is refused if EITHER layer says so, so neither one is optional: the global counter alone
 * (the design this comment used to describe, and argued for on the grounds that "keying by IP would
 * only tell an attacker to rotate addresses") is exactly the free denial-of-service `HttpServer.ts`'s
 * own comment now documents as closed, one stranger away from locking out the whole team at zero
 * cost. Dropping the global counter in favor of per-IP alone would just as surely be wrong the other
 * direction — that IS the "rotate addresses" attack the original argument warned about, and per-IP
 * alone gives it back for free. Both stay, because they defend against different attackers.
 *
 * `PgAttemptLimiter` survives a restart by design (state lives in the database, not the process), so
 * for whichever counter is holding a lockout, do not assume a restart clears it; see
 * `docs/ko/team-runbook.md`'s entry for a locked-out login for the real recovery — a per-IP lock
 * clears itself within its own window with no action needed, but the global lock (the one that
 * actually shuts out the whole team) still needs the database escape hatch documented there.
 *
 * `createAttemptLimiter`, this function — the in-memory implementation — is unaffected by any of
 * this: it still is, and always was, a single counter with no per-IP concept, state kept in memory
 * so it resets when the process does. That is fine because it never reaches production — `serve.ts`
 * (the one composition root this project has) constructs a `PgAttemptLimiter` instead, and has ever
 * since that class existed — so there is no free-DoS surface here for the two-layer design above to
 * close. What is actually left calling this function is `Login`'s own tests and its
 * optional-`account` fallback caller (see `Login`'s own comment for why that stays permissive) — a
 * database-free `AttemptLimiter` for a caller with no `Db` to hand it. See
 * docs/superpowers/specs/2026-07-29-dashboard-auth-options.md.
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
