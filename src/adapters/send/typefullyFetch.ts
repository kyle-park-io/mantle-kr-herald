export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 1000;

export interface TypefullyCallOptions {
  /**
   * Whether replaying this request is harmless. Defaults to true.
   *
   * Draft creation is the one call where it is not: a lost response is indistinguishable from a
   * rejected one, so replaying it can publish the same post twice — and the account's ceiling is
   * fifteen published posts a month, so a duplicate costs two of them.
   */
  idempotent?: boolean;
}

export type TypefullyFetch = (
  url: string,
  init?: RequestInit,
  opts?: TypefullyCallOptions,
) => Promise<Response>;

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-user-limit",
  "x-ratelimit-user-remaining",
  "x-ratelimit-user-reset",
  "x-ratelimit-socialset-limit",
  "x-ratelimit-socialset-remaining",
  "x-ratelimit-socialset-reset",
  "x-ratelimit-socialset-resource",
];

/**
 * Typefully documents per-user and per-social-set buckets but publishes no numbers, and the
 * social-set headers have never appeared on any read we have made. Logging whatever is present on
 * the first real 429 is how we find out what they say.
 *
 * `headers?.get?.()` rather than `headers.get()`: a fake Response in a test need not carry headers,
 * and a missing header must not turn a rate-limit log into a crash inside the retry loop.
 */
function rateLimitSummary(res: Response): string {
  const parts = RATE_LIMIT_HEADERS.map((h) => [h, res.headers?.get?.(h)] as const)
    .filter(([, v]) => v)
    .map(([h, v]) => `${h.replace("x-ratelimit-", "")}=${v}`);
  return parts.length > 0 ? parts.join(" ") : "(no rate-limit headers)";
}

/**
 * `fetch` with Typefully's failure modes handled: transient errors are retried with the same budget
 * and backoff as `HttpClient`, and the one call that must never be replayed can say so.
 *
 * Returns the `Response` untouched, so an adapter's existing `if (!res.ok)` handling is unchanged —
 * this only decides how many times the request is made.
 */
export function createTypefullyFetch(
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg: string) => void = console.warn,
): TypefullyFetch {
  return async (url, init, opts = {}) => {
    const idempotent = opts.idempotent ?? true;
    for (let attempt = 0; ; attempt++) {
      const last = attempt === RETRY_ATTEMPTS - 1;
      let res: Response;
      try {
        res = await fetchFn(url, init);
      } catch (err) {
        // A connection that died mid-flight is not proof the server did nothing. For a call that
        // must not be replayed, say so in the message — the operator, not a retry loop, decides.
        if (!idempotent) {
          throw new Error(
            `${(err as Error).message} — the request may still have been processed; check the Typefully queue before re-running`,
            { cause: err },
          );
        }
        if (last) throw err;
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }

      if (res.status === 429) log(`[typefully] 429 rate-limited · ${rateLimitSummary(res)}`);
      // A 429 replays safely even when the call is not idempotent: it was rejected before it was
      // processed, so there is nothing on the far side to duplicate.
      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (!retryable || last) return res;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  };
}
