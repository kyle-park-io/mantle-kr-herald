import type { IncomingMessage } from "node:http";
import type { ClientIpConfig } from "../../config";

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
 */
export function resolveClientIp(req: IncomingMessage, config: ClientIpConfig): string | undefined {
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
  return ip && ip.length > 0 ? ip : undefined;
}
