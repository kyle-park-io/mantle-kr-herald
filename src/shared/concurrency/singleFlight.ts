/**
 * Wraps `fn` so at most one call is in flight at a time. A call made while one is already running
 * is answered immediately by `busy()` rather than queued behind it — a queue that grows without
 * bound is the same resource-exhaustion shape as no limit at all, just delayed.
 *
 * Built for `POST /api/login` (`src/cli/serve.ts`): it is the one route the session gate leaves
 * open to unauthenticated callers, and `verifyPassword` (`domain/auth/password.ts`) deliberately
 * derives a slow, memory-hard scrypt hash (~64MB, 100–300ms) on every attempt — including a wrong
 * username, on purpose, for constant-time comparison. `Login.run` checks the attempt lockout first,
 * which throttles SEQUENTIAL guesses, but that check reads state before a concurrent request has
 * had a chance to record its own failure: N simultaneous `POST`s all pass it and all enqueue a
 * derivation. Node runs those on the libuv threadpool (default size 4), so an unauthenticated caller
 * holding every slot stalls everything else the process does with one — including serving the
 * static dashboard files — for free. Not specific to login, though: kept generic and tested in
 * isolation because the throttle is about the process's own capacity, not a login-specific rule.
 */
export function singleFlight<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
  busy: () => T,
): (...args: Args) => Promise<T> {
  let inFlight = false;
  return async (...args: Args): Promise<T> => {
    if (inFlight) return busy();
    inFlight = true;
    try {
      return await fn(...args);
    } finally {
      inFlight = false;
    }
  };
}
