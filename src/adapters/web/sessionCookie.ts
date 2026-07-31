// src/adapters/web/sessionCookie.ts

/** Name of the cookie carrying the signed session token (`src/domain/auth/session.ts`). */
export const SESSION_COOKIE_NAME = "herald_session";

/**
 * The `Set-Cookie` value that grants a session, on a successful `POST /api/login`.
 *
 * - `HttpOnly` — page JS never needs the token itself, only the fact of being signed in; keeping it
 *   out of `document.cookie` is one less place a stray XSS could read it from.
 * - `Secure` — never sent over plain http.
 * - `SameSite=Lax` — sent on this dashboard's own navigations and same-site fetches, never attached
 *   to a cross-site request. This is the cookie-side half of the boundary `refusalReason()` polices
 *   from the Origin-header side in `HttpServer.ts`; the two are independent defenses, not a chain
 *   where either alone would be enough.
 * - `Path=/` — every API route, not just the one that set it.
 * - `Max-Age` matches `ttlMs`, the token's own lifetime — a hint telling the browser when to stop
 *   sending the cookie, not what decides validity. `verifySession` checks the signed `issuedAt`
 *   inside the token regardless of what `Max-Age` a tampered client claims.
 */
export function buildSessionCookie(token: string, ttlMs: number): string {
  const maxAgeSeconds = Math.floor(ttlMs / 1000);
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}; Path=/`;
}

/**
 * Clears the session cookie — `POST /api/logout`. `Max-Age=0` deletes it immediately instead of
 * waiting out the token's own lifetime, which is what makes a sign-out actually sign out rather than
 * just stop being enforced client-side.
 */
export const CLEARED_SESSION_COOKIE = `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`;

/** The session token out of a raw `Cookie` request header, or `undefined` if it is not present. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}
