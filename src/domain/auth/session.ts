import { createHmac, timingSafeEqual } from "node:crypto";

/** What a signed session token carries. */
export interface SessionPayload {
  /**
   * ISO instant the token was issued. The lifetime is checked against THIS field, inside the
   * signed payload — never against the cookie's own `Max-Age`, which the client controls and could
   * replay with a longer value to outlive the token it was handed.
   */
  issuedAt: string;
}

/**
 * How long a session stays valid after `issuedAt`, enforced inside `verifySession` itself rather
 * than by the cookie's `Max-Age`. This is `verifySession`'s *default* `ttlMs` — the value it uses
 * when a caller does not pass one, which is every caller in this codebase today, since
 * `loadSessionConfig()` (`src/config.ts`) never returns anything else. The cookie's `Max-Age` is
 * always set from that same `SessionConfig.ttlMs`, so it stays a hint to the browser about when to
 * stop sending the cookie — the token, verified against whatever `ttlMs` its caller actually passed,
 * is what decides.
 *
 * 12 hours: a working day, then sign in again. The dashboard has one shared account, so there is no
 * per-user session list to reason about — only "how long is a stolen cookie worth."
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Length-independent equality — mirrors `credentials.ts`'s `equalsInConstantTime`. */
function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.length !== actualBuf.length) {
    // Still compare something of the right shape so a length mismatch costs the same as a match.
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * `${base64url(JSON payload)}.${base64url(HMAC-SHA256 signature)}` — deliberately not a JWT. The
 * auth-options record (`docs/superpowers/specs/2026-07-29-dashboard-auth-options.md`) argued this
 * and it is settled: one frontend talking to one API never collects a JWT's actual benefit
 * (stateless verification shared across services), but still pays its costs — a JWT's payload is
 * merely base64, readable by anyone who has the cookie, and it stays valid for its whole lifetime
 * with no way to revoke a single one early.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Never throws. Malformed input — a missing cookie, a hand-edited one, garbage from a client that
 * is not this dashboard — is simply an unauthenticated request, not a 500: every failure path
 * (wrong shape, wrong signature, expired) returns `undefined` alike, so a caller can never learn
 * which one happened, the same rule `checkCredentials` applies to a wrong username vs. password.
 *
 * `ttlMs` defaults to `SESSION_TTL_MS` but is a real parameter, not a label on the module constant:
 * `HttpServer.ts`'s `currentSession()` passes `sessionConfig.ttlMs` explicitly, the same value
 * `buildSessionCookie` sets the cookie's `Max-Age` from, so the two can never enforce different
 * lifetimes even though `loadSessionConfig()` only ever produces one value today.
 */
export function verifySession(token: string, secret: string, now: Date, ttlMs: number = SESSION_TTL_MS): SessionPayload | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return undefined;
    const [body, signature] = parts;
    if (!body || !signature) return undefined;
    if (!signaturesMatch(sign(body, secret), signature)) return undefined;

    // Only reached once the signature above has already matched — an attacker without `secret`
    // can never produce a body whose signature verifies, so nothing unsigned ever gets this far.
    const parsed: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { issuedAt?: unknown }).issuedAt !== "string") {
      return undefined;
    }
    const payload = parsed as SessionPayload;
    const issuedAt = new Date(payload.issuedAt);
    if (Number.isNaN(issuedAt.getTime())) return undefined;
    if (now.getTime() - issuedAt.getTime() > ttlMs) return undefined;

    return payload;
  } catch {
    // JSON.parse (or anything else above) rejecting a malformed body is still an unauthenticated
    // request, not a crash.
    return undefined;
  }
}
