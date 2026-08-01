import type { ClientIpConfig } from "../../config";

/**
 * Just enough of a request for `resolveClientIp` to read — a real Node `IncomingMessage` satisfies
 * this structurally without any change at its call site (`HttpServer.ts`), and so does the small
 * shim `api/[...path].ts` builds over a Vercel Web-standard `Request`, which has no `.socket` at
 * all. Narrowed to exactly the two fields this function touches rather than the full
 * `IncomingMessage` shape, so a second runtime with a differently-shaped request object never has to
 * fake fields it does not have.
 */
export interface ClientIpRequest {
  socket: { remoteAddress?: string };
  // An index signature, not a single named `"x-forwarded-for"` property: `IncomingHttpHeaders`
  // itself only carries that header through ITS OWN index signature (`NodeJS.Dict`), and a target
  // type with nothing but optional named properties trips TypeScript's "weak type" check against a
  // source with no property of that exact name — an index signature on both sides sidesteps it.
  headers: Record<string, string | string[] | undefined>;
}

/**
 * How long a trusted `X-Forwarded-For` entry may be before `resolveClientIp` refuses to use it as a
 * row id — see `looksLikeAnAddress`'s own comment for why this check exists at all. Generous: the
 * longest a real IPv4-mapped IPv6 literal gets is well under 50 characters; 64 leaves headroom without
 * coming close to accepting arbitrary client-supplied text.
 */
const TRUSTED_ENTRY_MAX_LENGTH = 64;

/** Digits, hex letters, `.`, `:`, and an optional wrapping `[...]` — everything a real IPv4 or IPv6 literal is made of, nothing else. */
const IP_SHAPE = /^\[?[0-9a-fA-F:.]+\]?$/;

/**
 * A coarse shape check, not real IP validation — `resolveClientIp` has no need to reject a
 * malformed-but-address-shaped value; the proxy this trust boundary already assumes is honest is the
 * one writing this entry. What this guards against is different: a MISCONFIGURED
 * `HERALD_TRUST_PROXY_HOPS` pointing past the trusted proxy's own appended entry, into chain positions
 * a client fully controls (`resolveClientIp`'s own comment on counting from the end explains why
 * everything left of the trusted position is exactly that). Without this check, that value becomes an
 * `auth_attempts` row id verbatim (`ipRowId` in `PgAttemptLimiter.ts`) — unvalidated, arbitrarily long,
 * fully client-chosen text as a primary key. Rejecting it here degrades to the same safe fallback every
 * other unusable case already does: `resolveClientIp` returns `undefined`, and the caller keys the
 * request under the global counter alone rather than under whatever the client sent.
 */
function looksLikeAnAddress(value: string): boolean {
  return value.length <= TRUSTED_ENTRY_MAX_LENGTH && IP_SHAPE.test(value);
}

/**
 * The client IP the per-IP login lockout (`PgAttemptLimiter`'s `ip:<address>` rows, via
 * `attemptLimiter.ts`'s two-layer design) should key on for this request — or `undefined` when
 * nothing here can be trusted, in which case the caller must fall back to the global counter alone
 * rather than key everything under one bogus value (`serve.ts`'s composed `login` does exactly
 * that).
 *
 * `config.trustProxy` decides everything:
 *
 * - **`false` (the default).** `req.socket.remoteAddress` — the actual TCP peer — and nothing else.
 *   `X-Forwarded-For` is a plain request header: any client can set it to whatever it likes, on
 *   every request, to a different value each time. Reading it here without a trusted proxy in front
 *   would not weaken per-IP limiting, it would DEFEAT it outright — an attacker sending a fresh
 *   forged value on every attempt makes every single failure land on a brand-new row, so no address
 *   ever accumulates enough failures to lock, while the mechanism appears to be working (rows ARE
 *   being created and locked, just one each, forever). The socket address has no such hole: it is
 *   what the OS itself recorded the connection as, not anything the client's request declared.
 * - **`true`.** The socket address is no longer the client — it is whichever reverse proxy this
 *   server sits behind — so it reads `X-Forwarded-For` instead, at the position
 *   `config.trustedHopsFromEnd` counts from the END of the comma-separated chain. Counting from the
 *   end, not the start, is the whole point: a proxy that behaves correctly APPENDS the address it
 *   received the connection from to whatever the client already sent, so only entries near the end
 *   are things the proxy itself vouches for — everything to their left is exactly what the client
 *   (or an attacker) supplied and must never be trusted, no matter how many proxies are configured
 *   as trusted. `trustedHopsFromEnd: 1` (the common case — one reverse proxy directly in front of
 *   this server) reads the very last entry.
 *
 * Both header-shaped failure modes here return `undefined` rather than the socket address: a header
 * that is missing entirely, or a chain shorter than `trustedHopsFromEnd` (someone set `trustProxy`
 * without the proxy actually being there, or a malformed request), leaves the socket address as the
 * PROXY's own fixed address, not any real client's — keying every distinct visitor's failures under
 * that one value would be worse than no per-IP limiting at all, since it would let any single
 * attacker exhaust the "IP"'s allowance and, in doing so, lock out every legitimate caller behind
 * the same proxy. Nothing today actually sets `trustProxy` — `HttpServer.ts` still binds
 * 127.0.0.1-only, with nothing in front of it — so this whole branch is written for the hosted
 * future (`Plan C`), not proof any of it has been exercised against a real proxy yet.
 *
 * A third failure mode lives at the entry itself, not the chain: `looksLikeAnAddress` rejects
 * whatever the hop count landed on if it is not coarsely IP-shaped or is implausibly long, and that
 * rejection degrades the same way — `undefined`, global-only. See its own comment for why this exists
 * even though the position it reads is, by the whole point of counting from the end, one the trusted
 * proxy vouches for: it is a hedge against a MISCONFIGURED hop count landing on client-controlled
 * territory instead, not a doubt about a correctly configured proxy's own entry.
 */
export function resolveClientIp(req: ClientIpRequest, config: ClientIpConfig): string | undefined {
  if (!config.trustProxy) return req.socket.remoteAddress ?? undefined;

  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;

  const chain = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const index = chain.length - config.trustedHopsFromEnd;
  const ip = index >= 0 ? chain[index] : undefined;
  return ip && looksLikeAnAddress(ip) ? ip : undefined;
}
