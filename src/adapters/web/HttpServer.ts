// src/adapters/web/HttpServer.ts
import { createServer, type Server, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, resolve, sep } from "node:path";
import { handleApi, isLoginRoute, type ApiDeps } from "./apiHandlers";
import { readSessionToken } from "./sessionCookie";
import { verifySession, type SessionPayload } from "../../domain/auth/session";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Everything an HTML form can post without a preflight. The dashboard sends JSON, or no body. */
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin served from this machine — the dashboard itself, or Vite's dev server proxying to it. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false; // including `Origin: null` — an opaque origin is not this machine
  }
}

/**
 * Why a request must be refused before it reaches a route, or `undefined`.
 *
 * This used to be the whole security model — "no auth, bound to loopback" — and that sentence is no
 * longer true. It is not the only guard anymore, and it is not the first one a request meets:
 *
 * 1. **The session gate.** Every `/api/` route except `POST /api/login` (and, separately,
 *    `/api/publish/local/*`, gated the same way one step down) requires a valid, signed, `httpOnly`,
 *    `SameSite=Lax` session cookie — see `apiHandlers.ts`'s `handleApi` and `currentSession()` below.
 *    Read or write, unauthenticated now means 401, with no detail about why. This is the actual
 *    boundary a stranger who is not on this machine runs into first.
 * 2. **This function**, still. It exists for the one class of request the session cookie's own
 *    `SameSite=Lax` cannot be fully trusted to stop by itself: a cross-site `POST` that rides along
 *    with whatever a browser decides is or is not "top-level" for cookie purposes, from any page the
 *    operator happens to have open. `POST /api/outlets/:itemId/:type/:outletId/send` takes no body,
 *    which makes it a *simple* request — no preflight, so CORS never gets a say and the browser just
 *    sends it. Refusing by `Origin` does not depend on any of that being handled correctly; it is
 *    independent, not a fallback for a cookie the gate above already checks.
 *
 * - **Origin** — present and not loopback: refused. *Any* loopback port is accepted rather than this
 *   server's own, because `pnpm dev:web` serves the UI from Vite on :5173 and proxies `/api` here
 *   with the browser's original `Origin` intact. A page already served from this machine is past
 *   every boundary this could defend anyway.
 * - **content-type** — the three an HTML form can produce are refused outright, which covers a
 *   client that sends no `Origin` at all. Costs nothing: every dashboard call sends JSON or no body.
 *
 * `GET` is untouched by this function specifically — the session gate is what now reaches it too, so
 * the SPA shell and the static files under `staticDir` are the only things actually unaffected; the
 * local publish reader is not (see its own guard, just past this one, in `startServer`).
 *
 * **What still is not guarded, by design or by what this plan covers:** the server still binds to
 * 127.0.0.1 only — `Plan C`, not this one, is what makes it reachable from anywhere else, and
 * everything above is written for that future, not proof it has already arrived. There is no CSRF
 * token; the cookie's `SameSite` plus the Origin check above stand in for one, which is adequate for
 * a single shared account and would need revisiting for anything with per-user sessions. A stolen
 * cookie is valid until it expires (12h) or `HERALD_SESSION_SECRET` is rotated — there is no
 * server-side session list to revoke one entry from, the same tradeoff the auth-options record
 * accepted in choosing a signed cookie over a JWT and not reopening it here. And since the account is
 * shared, nothing here can answer "which person did this" — only "someone with the password did."
 * The cookie is `Secure`, so a browser will not send it — or store it in the first place — over plain
 * `http://` to anything but a loopback host: login would still answer 200 (the response itself is not
 * blocked), but the cookie never gets set, so every request after it 401s and the user bounces to
 * `#login` forever with no message explaining why. Harmless today, since every host this plan covers
 * is loopback and browsers treat `localhost`/`127.0.0.1` as a secure context regardless of scheme —
 * listed here because this comment is written for the hosted future, where serving this over plain
 * HTTP to a real hostname would be exactly this failure, not proof it is already a problem.
 * The login lockout and the single-flight guard combine into a free denial of service on signing in,
 * not on anything behind the gate: a caller who alternates a wrong guess (tripping
 * `PgAttemptLimiter`'s lockout) with a flood of concurrent `POST /api/login`s (occupying
 * `singleFlight`'s one derivation slot in `serve.ts`) can keep the whole team out indefinitely at no
 * cost to themselves — a busy refusal never reaches the limiter, and a lockout refusal never reaches
 * scrypt, so neither guard ever pays for the other's refusal. This is deliberately not fixed here; see
 * `attemptLimiter.ts`'s own comment for why the lockout is not redesigned, and
 * `docs/ko/team-runbook.md`'s entry for a locked-out login for the escape hatch a locked-out team
 * actually has now that the lockout survives a restart (`delete from auth_attempts where id =
 * 'singleton'`).
 */
export function refusalReason(method: string, origin?: string, contentType?: string): string | undefined {
  if (!STATE_CHANGING.has(method.toUpperCase())) return undefined;
  if (origin !== undefined && !isLoopbackOrigin(origin)) return "cross-site request refused";
  if (contentType && FORM_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) {
    return "form-encoded request refused";
  }
  return undefined;
}

/**
 * The verified session for this request, or `undefined`. Read from the `Cookie` header and checked
 * against `secret` once, right here — `HttpServer` is the one place a raw HTTP header exists, and
 * handing the already-verified payload to `handleApi` (via `ApiDeps.session`) keeps that function
 * testable without a real HTTP request. `verifySession` never throws, so a malformed or absent
 * cookie ends up `undefined` the same as a genuinely missing one.
 */
function currentSession(req: IncomingMessage, secret: string): SessionPayload | undefined {
  const token = readSessionToken(req.headers.cookie);
  return token ? verifySession(token, secret, new Date()) : undefined;
}

/**
 * Bytes past which `readBody` gives up rather than keep concatenating — measured against what is
 * actually read off the socket, not the client-declared `Content-Length` (which a request can omit,
 * understate, or lie about), so a request cannot buffer past the cap just by mislabeling itself.
 *
 * 2 MiB is far above the largest legitimate payload on this API. Every write route on this API sends
 * at most one free-text field (`koreanText`, rendering `text`, …) plus a handful of short strings and
 * booleans; the design spec's own upper bound for the longest of those — an X Article's `sourceText`
 * — is ~12,000 characters, under 50 KB even in the worst-case multi-byte UTF-8 encoding. The cap
 * exists to bound memory, not to police content size, so nothing here is expected to ever get close
 * to it.
 */
const MAX_API_BODY_BYTES = 2 * 1024 * 1024;

/** Thrown by `readBody` when a request body exceeds `MAX_API_BODY_BYTES`. */
class BodyTooLargeError extends Error {}

async function readBody(req: import("node:http").IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function startServer(deps: ApiDeps, opts: { port: number; staticDir: string; localPublishDir: string }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Hoisted so the catch block at the bottom can tell an authenticated failure from an
    // unauthenticated one — set inside the `/api/` branch below, left `undefined` for every request
    // that never got that far (a static asset, or `POST /api/login` itself).
    let session: SessionPayload | undefined;
    try {
      // Before any route: a state-changing request from somewhere else never reaches a use case.
      const refusal = refusalReason(req.method ?? "GET", req.headers.origin, req.headers["content-type"]);
      if (refusal) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: refusal }));
        return;
      }
      if (url.pathname.startsWith("/api/publish/local/")) {
        // Not routed through `handleApi` — its own gate, mirroring the one at the top of that
        // function, since this is the one `/api/` path that bypasses it entirely. It serves
        // unpublished review/approved markdown in local storage mode, which is exactly the kind of
        // content "the board is not public" is about.
        if (!currentSession(req, deps.sessionConfig.secret)) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "unauthenticated" }));
          return;
        }
        try {
          const rel = normalize(decodeURIComponent(url.pathname.slice("/api/publish/local/".length)))
            .replace(/^(\.\.[/\\])+/, "")
            .replace(/^[/\\]+/, "");
          const filePath = join(opts.localPublishDir, rel);
          // Defense in depth: the resolved path must stay under the publish-local root.
          if (resolve(filePath) !== resolve(opts.localPublishDir) && !resolve(filePath).startsWith(resolve(opts.localPublishDir) + sep)) {
            res.writeHead(404).end();
            return;
          }
          const data = await readFile(filePath);
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(data);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        session = currentSession(req, deps.sessionConfig.secret);
        // Refused before the body is ever read. `readBody` used to run unconditionally here, ahead
        // of this same gate inside `handleApi` — an unauthenticated 20 MB `PUT` was fully read and
        // concatenated before the 401 that was always coming ever went out. A request the gate is
        // about to refuse must not first be made to pay for buffering whatever it sent; `req.destroy()`
        // drops the connection rather than draining the rest of a body nobody is going to look at.
        if (!session && !isLoginRoute(req.method ?? "GET", url.pathname)) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "unauthenticated" }));
          req.destroy();
          return;
        }
        let body: unknown;
        if (req.method === "POST" || req.method === "PUT") {
          try {
            body = await readBody(req, MAX_API_BODY_BYTES);
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "request body too large" }));
              req.destroy();
              return;
            }
            throw err;
          }
        }
        const result = await handleApi({ ...deps, session }, req.method ?? "GET", url.pathname, body);
        const payload = JSON.stringify(result.json);
        const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
        if (result.setCookie) headers["Set-Cookie"] = result.setCookie;
        res.writeHead(result.status, headers).end(payload);
        return;
      }
      // static: map path to a file under staticDir, default to index.html (SPA fallback)
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
      let filePath = join(opts.staticDir, rel);
      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        filePath = join(opts.staticDir, "index.html");
        data = await readFile(filePath);
      }
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" }).end(data);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (session) {
        // An authenticated caller is a trusted team operator, not a stranger — the same tier as one
        // running this command from a terminal, where an uncaught error already prints its own
        // message. There is nothing in `err.message` here that a signed-in team member does not
        // already have access to, and the detail is what lets them fix it without needing a
        // terminal.
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: message }));
        return;
      }
      // No session — in practice always `POST /api/login`, the one route reachable without one (a
      // static asset failing this hard is a broken install, not a request this is written for). A
      // driver failure reached from `Login` → `PgAttemptLimiter` (a bad `DATABASE_URL`, an
      // unmigrated schema, a rejected password) must not hand an unauthenticated caller the driver's
      // own text — schema names, internal hostnames, database usernames. Same bar the 401 above
      // already holds itself to: no detail about why. The real message still goes somewhere — the
      // server's own log — rather than nowhere.
      console.error("unauthenticated request failed:", err);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "internal error" }));
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}
