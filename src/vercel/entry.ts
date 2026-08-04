// src/vercel/entry.ts
//
// The Vercel entry point's real body. `api/[...path].ts` is a two-line re-export of the bundle built
// from this file — see that file for why it cannot simply live under `api/` any more.
//
// Living under `src/` has a second effect worth stating: `tsconfig.json` includes `src`, so
// `pnpm typecheck` now covers this file. While it sat in `api/` it was checked by nothing — not the
// local typecheck, not CI — and the first production deploy printed a screenful of
// `Property 'headers' does not exist on type 'Request'` from Vercel's own compile of it.
//
// A thin adapter, on purpose: everything that decides what
// a request means — routing, use-case logic, the session gate, the CSRF guard — already lives in
// `handleApi` (`apiHandlers.ts`) and `refusalReason` (`HttpServer.ts`), both written for
// `pnpm serve`'s `node:http` server. This file's only job is turning a Vercel Function's Web-standard
// `Request` into the `(method, path, body)` those functions already expect, and turning their answer
// back into a `Response` — no routing or use-case logic of its own.
//
// `export const config` and the default `{ fetch }` export are the documented shape for a Vercel
// Function that handles every HTTP method from one file
// (https://vercel.com/docs/functions/runtimes/node-js) — stated explicitly rather than left to the
// platform default, the same "never inferred" register this codebase applies to every other choice
// that would be silently wrong if guessed: `pg` (the Postgres driver `Db` is built over) needs a real
// TCP socket, which the Edge runtime does not have.
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import { wrapPool } from "../adapters/db/createDb";
import { createDeps } from "../app/createDeps";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import { handleApi, isLoginRoute } from "../adapters/web/apiHandlers";
import { refusalReason, currentSession, MAX_API_BODY_BYTES, BodyTooLargeError } from "../adapters/web/HttpServer";
import { resolveClientIp, type ClientIpRequest } from "../adapters/web/clientIp";
import { loadDbConfig, loadDeploymentOrigin, loadClientIpConfig, loadStorageMode } from "../config";
import type { StorageMode } from "../config";

export const config = { runtime: "nodejs" };

function jsonResponse(status: number, json: unknown, setCookie?: string): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(json), { status, headers });
}

/**
 * Just enough of a Vercel `Request` for `resolveClientIp` to read. There is no raw socket on a
 * Web-standard `Request` the way `node:http`'s `IncomingMessage` has one — Vercel's own edge network
 * is what actually terminates the client connection, and it is the one thing that can set
 * `X-Forwarded-For` truthfully here (unlike a request that reached `HttpServer.ts` directly, nothing
 * can reach this function without passing through it first). `getHandler()` below refuses to start
 * unless `HERALD_TRUST_PROXY=true` is set for exactly this reason — without it, every request here
 * resolves to "no trustworthy address" and the per-IP login lockout layer never gets a key to count
 * anything against.
 */
function toClientIpRequest(request: Request): ClientIpRequest {
  return { socket: {}, headers: { "x-forwarded-for": request.headers.get("x-forwarded-for") ?? undefined } };
}

/**
 * Reads a JSON body off a Web-standard `Request`, capped at `maxBytes` measured against what is
 * actually read off the stream — the same rule `HttpServer.ts`'s `readBody` enforces for
 * `node:http`, reused here as the same constant and the same error type rather than a second,
 * independently-chosen limit. `request.body` is `null` for a bodyless request (every GET, and any
 * POST/PUT the caller sent with nothing) — treated as "no body", same as an empty stream.
 *
 * This is NOT the first line of defense against an oversized body on this platform, and does not
 * claim to be — see the comment above the 401 check in `createHandler` for what Vercel's own
 * platform-level 4.5 MB accept limit already does (and does not) bound before this function, or this
 * cap, ever runs. What this specifically adds: a caller who gets PAST the 401 (an authenticated
 * request, or the login route) still cannot send this function something between `maxBytes` and the
 * platform's own ceiling without an explicit 413 from HERE, at the size this API actually expects to
 * handle rather than the platform's much larger generic one.
 */
async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const body = request.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(Buffer.from(combined).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Builds the request handler over an already-constructed `deps` and `deploymentOrigin` — kept
 * separate from the real, env-reading construction at the bottom of this file so
 * `tests/adapters/web/vercelHandler.test.ts` can hand it a `createDeps({ db: <PGlite>, routes:
 * "hosted" })` and a fixed origin string, and never touch a real Postgres connection, a real
 * `DATABASE_URL`, or any other real env var. The default export's `fetch` — the only thing Vercel
 * itself ever calls — is this function closed over deps built from the real environment.
 */
export function createHandler(deps: ApiDeps, deploymentOrigin: string): (request: Request) => Promise<Response> {
  /** An origin this deployment actually serves from. Exact match: `HERALD_DEPLOYMENT_ORIGIN` is
   *  scheme + host only (`config.ts`'s `loadDeploymentOrigin` refuses anything else), and `URL`
   *  normalizes both sides the same way, so this never has to worry about a trailing slash or a
   *  differently-cased host meaning two origins that are really the same one. */
  function isAllowedOrigin(origin: string): boolean {
    try {
      const url = new URL(origin);
      return `${url.protocol}//${url.host}` === deploymentOrigin;
    } catch {
      return false; // including `Origin: null` — an opaque origin is not this deployment
    }
  }

  return async function handle(request: Request): Promise<Response> {
    const method = request.method ?? "GET";
    const url = new URL(request.url);

    // Before anything else, including the session check below: a state-changing request from
    // somewhere else never reaches a use case. `refusalReason` is the exact function
    // `HttpServer.ts` enforces the local equivalent of this guard with — reused, not
    // reimplemented, so there is one CSRF rule rather than two that could quietly drift apart.
    // Only WHICH origins count as "this deployment" differs, which is why `isAllowedOrigin` above
    // is a parameter rather than baked into `refusalReason` itself.
    const refusal = refusalReason(
      method,
      request.headers.get("origin") ?? undefined,
      request.headers.get("content-type") ?? undefined,
      isAllowedOrigin,
    );
    if (refusal) return jsonResponse(403, { error: refusal });

    const session = currentSession(
      { headers: { cookie: request.headers.get("cookie") ?? undefined } },
      deps.sessionConfig.secret,
      deps.sessionConfig.ttlMs,
    );
    // Only the login route reads this — computed unconditionally anyway, the same place `session`
    // is, mirroring `HttpServer.ts`'s own per-request shape.
    const clientIp = resolveClientIp(toClientIpRequest(request), deps.ipConfig);

    // The 401 before THIS FUNCTION reads the body — but read what that does and does not buy
    // carefully, because it is weaker here than the sentence used to claim.
    //
    // `HttpServer.ts` owns the raw TCP connection: it can refuse before ever reading a byte off the
    // socket, and `req.destroy()` drops the connection outright for a body it is not going to read.
    // A Vercel Function has no equivalent. Vercel's platform accepts the request body at the edge —
    // up to its own 4.5 MB limit, above which the platform itself answers
    // `FUNCTION_PAYLOAD_TOO_LARGE` before this code runs at all — and delivers it already buffered
    // WITH the invocation. There is nothing this function can do, at any point in its own code, to
    // make the platform refuse that accept: an unauthenticated caller can always make Vercel's edge
    // buffer up to 4.5 MB per request, regardless of this ordering.
    //
    // What this ordering DOES buy: this function's own heap never allocates a second copy via
    // `readJsonBody`'s chunked read, and never spends a `JSON.parse`, on a request that was always
    // going to be refused — and `MAX_API_BODY_BYTES` (2 MiB) still does real work for an
    // AUTHENTICATED caller who sends something too large: `readJsonBody` below answers 413 for
    // exactly that, in the 2–4.5 MB window the platform's own limit does not cover. `request.body`
    // is not touched above this line — only headers — so the stream genuinely is unconsumed by OUR
    // code when this returns; it says nothing about what the platform already did with it.
    if (!session && !isLoginRoute(method, url.pathname)) {
      return jsonResponse(401, { error: "unauthenticated" });
    }

    let body: unknown;
    if (method === "POST" || method === "PUT") {
      try {
        body = await readJsonBody(request, MAX_API_BODY_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          return jsonResponse(413, { error: "request body too large" });
        }
        throw err;
      }
    }

    try {
      const result = await handleApi({ ...deps, session, clientIp }, method, url.pathname, body);
      return jsonResponse(result.status, result.json, result.setCookie);
    } catch (err) {
      if (session) {
        // An authenticated caller is a trusted team operator — same bar `HttpServer.ts` applies to
        // its own equivalent catch.
        return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
      }
      console.error("unauthenticated request failed:", err);
      return jsonResponse(500, { error: "internal error" });
    }
  };
}

const TRUST_PROXY_REMEDY =
  "Set HERALD_TRUST_PROXY=true (and, if this deployment sits behind more than one hop, " +
  "HERALD_TRUST_PROXY_HOPS) — see .env.example's hosted-deployment section.";

/**
 * Refuses to build the handler when this deployment has no way to trust `X-Forwarded-For` —
 * `toClientIpRequest`'s own comment has the mechanism: a Vercel `Request` has no raw socket, so with
 * `HERALD_TRUST_PROXY` off, `resolveClientIp` returns `undefined` for every single request and the
 * per-IP login lockout layer never gets a key to count anything against — only the global
 * 50-failure backstop is left standing. That is not a degraded version of the two-layer design
 * (`attemptLimiter.ts`); it is the exact "one stranger holds the whole team's login out" shape the
 * per-IP layer exists to prevent, silently, with nothing in a log or on screen saying so. Refused
 * here, at startup, in the same register `loadDeploymentOrigin()` already uses for "no safe default
 * to guess" — rather than left as a note in `.env.example` nobody reads until it matters.
 *
 * Its own function, pulled out of `getHandler()` below, so it is testable without a real
 * `DATABASE_URL` or `Pool` — the same reason `createHandler` itself is a separate export.
 */
export function assertTrustProxy(config: { trustProxy: boolean }): void {
  if (!config.trustProxy) {
    throw new Error(`HERALD_TRUST_PROXY must be true on the hosted deployment. ${TRUST_PROXY_REMEDY}`);
  }
}

/**
 * The same refusal, for the other variable this deployment can be pointed at the wrong place with.
 *
 * `HERALD_STORAGE_MODE` is [REQUIRED] for every entry point, so `loadStorageMode()` already catches
 * an unset value here — but not a wrong one, and `local` is wrong here in a way nothing downstream
 * reports: publishing resolves to the local target (`resolveTargets`, src/cli/uploaders.ts), which
 * writes approved documents onto this function's own ephemeral filesystem. The upload returns
 * success, the dashboard shows a published row, and the links are dead — the files left with the
 * instance. That is the same class of silent-degradation `assertTrustProxy` exists to refuse, so it
 * is refused the same way, at startup, rather than left to a note in `.env.example`.
 *
 * Not pushed down into `loadStorageMode()` itself: `local` is the correct, documented value for
 * `pnpm serve` (`.env.example` §1 ships it, and the whole pipeline is meant to run that way before
 * any cloud credential exists). This is a statement about where the code is running, not about the
 * value — which is why it lives in the hosted entry point, next to the other one.
 */
export function assertCloudStorage(mode: StorageMode): void {
  if (mode !== "cloud") {
    throw new Error(
      `HERALD_STORAGE_MODE must be "cloud" on the hosted deployment (got "${mode}"). With "local", ` +
        "approved documents are written to this function's ephemeral filesystem and every published " +
        "link is dead, with nothing reporting a failure. Set HERALD_STORAGE_MODE=cloud in the Vercel " +
        "project's environment variables — see .env.example's hosted-deployment section.",
    );
  }
}

/**
 * Built once per function instance, lazily on first request rather than at module load — so merely
 * IMPORTING this file (as the test file above does, to reach `createHandler`) never requires a real
 * `DATABASE_URL` or opens a real connection. `attachDatabasePool` + a fresh `pg.Pool` here, not
 * `createDb()`: Fluid Compute needs the raw `Pool` to release idle clients before this instance
 * suspends, and `createDb()` does not hand it back.
 */
let handler: ((request: Request) => Promise<Response>) | undefined;
function getHandler(): (request: Request) => Promise<Response> {
  if (!handler) {
    // Fail fast, before ever opening a connection — same register `serve.ts` uses for its own early
    // block. `createDeps` below re-validates session/client-ip/auth config internally too (it has
    // to: it is the shared composition root, not owned by this one caller) — re-running these pure,
    // side-effect-free env reads is harmless.
    const dbConfig = loadDbConfig();
    const deploymentOrigin = loadDeploymentOrigin();
    assertTrustProxy(loadClientIpConfig());
    assertCloudStorage(loadStorageMode());

    const pool = new Pool({ connectionString: dbConfig.url });
    attachDatabasePool(pool);
    const deps = createDeps({ db: wrapPool(pool), routes: "hosted" });
    handler = createHandler(deps, deploymentOrigin);
  }
  return handler;
}

export default {
  fetch: (request: Request): Promise<Response> => getHandler()(request),
};
