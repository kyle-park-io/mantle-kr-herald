/**
 * Talking to a deployed instance: one HTTP helper, a login, and authenticated calls.
 *
 * The reason this is a module and not two functions is a bug it makes unrepresentable. On
 * 2026-08-10 `deploy-smoke.ts` called `/api/diagnostics/live` without the session cookie that every
 * sibling call passed. The route is gated like every route but `/api/login`, so it answered 401 on
 * every run, `probes` came back `undefined`, and the liveness check reported "the deployment could
 * not be read" — for a deployment that was perfectly healthy. The feature had never once executed,
 * and a full green suite plus four clean reviews had nothing to say about it.
 *
 * So the cookie is not a header a caller remembers to add. `authed()` attaches it inside the client,
 * making an authenticated request without the session impossible by construction. `request()` is the
 * unauthenticated escape hatch for gated routes; call sites are held to using `authed()` for such
 * routes by test.
 */

export interface DeploymentClient {
  /** Scheme + host only — the exact shape the CSRF guard compares an `Origin` against. */
  readonly origin: string;
  readonly loggedIn: boolean;
  /** One call, or `undefined` on a network failure. Never throws. */
  request(path: string, init?: RequestInit): Promise<Response | undefined>;
  /** POSTs `/api/login` and remembers the session. Returns the status, or -1 if it never completed. */
  logIn(username: string, password: string): Promise<number>;
  /** A call carrying the session cookie. Throws if there is no session — the cookie is attached by `authed()`, not by the caller. */
  authed(path: string, init?: RequestInit): Promise<Response | undefined>;
  forgetSession(): void;
}

export function createDeploymentClient(
  origin: string,
  fetchFn: typeof fetch = fetch,
  onError: (message: string) => void = (m) => console.error(m),
): DeploymentClient {
  let cookie: string | undefined;

  const request = async (path: string, init?: RequestInit): Promise<Response | undefined> => {
    try {
      return await fetchFn(`${origin}${path}`, init);
    } catch (err) {
      onError(`  (request to ${path} failed: ${err instanceof Error ? err.message : String(err)})`);
      return undefined;
    }
  };

  return {
    origin,
    get loggedIn(): boolean {
      return cookie !== undefined;
    },
    request,
    async logIn(username: string, password: string): Promise<number> {
      const res = await request("/api/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res?.status === 200) cookie = res.headers.get("set-cookie")?.split(";")[0];
      return res?.status ?? -1;
    },
    async authed(path: string, init?: RequestInit): Promise<Response | undefined> {
      if (cookie === undefined) {
        throw new Error(`authed(${path}) called before a successful log in — this is a programming error`);
      }
      const headers = new Headers(init?.headers);
      headers.set("cookie", cookie);
      return request(path, { ...init, headers });
    },
    forgetSession(): void {
      cookie = undefined;
    },
  };
}
