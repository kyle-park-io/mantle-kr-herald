// api/[...path].ts
//
// The Vercel entry point (Plan C Task 2). A thin adapter, on purpose: everything that decides what
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
import { wrapPool } from "../src/adapters/db/createDb";
import { createDeps } from "../src/app/createDeps";
import type { ApiDeps } from "../src/adapters/web/apiHandlers";
import { handleApi, isLoginRoute } from "../src/adapters/web/apiHandlers";
import { refusalReason, MAX_API_BODY_BYTES, BodyTooLargeError } from "../src/adapters/web/HttpServer";
import { readSessionToken } from "../src/adapters/web/sessionCookie";
import { verifySession } from "../src/domain/auth/session";
import { resolveClientIp, type ClientIpRequest } from "../src/adapters/web/clientIp";
import { loadDbConfig, loadDeploymentOrigin } from "../src/config";

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
 * can reach this function without passing through it first). This deployment therefore needs
 * `HERALD_TRUST_PROXY=true` for the per-IP login lockout to key on anything but "no trustworthy
 * address" — documented in `.env.example`'s hosted-deployment section.
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

    const session = (() => {
      const token = readSessionToken(request.headers.get("cookie") ?? undefined);
      return token ? verifySession(token, deps.sessionConfig.secret, new Date(), deps.sessionConfig.ttlMs) : undefined;
    })();
    // Only the login route reads this — computed unconditionally anyway, the same place `session`
    // is, mirroring `HttpServer.ts`'s own per-request shape.
    const clientIp = resolveClientIp(toClientIpRequest(request), deps.ipConfig);

    // The 401 before the body is EVER read. `HttpServer.ts` was fixed for exactly this: an
    // unauthenticated caller must not be able to make this function buffer an arbitrarily large
    // body before the refusal that was always coming. `request.body` above (in `toClientIpRequest`
    // and the CSRF check) is never touched — only headers — so at this point the body stream is
    // still completely unconsumed; returning now without calling `readJsonBody` is what keeps it
    // that way.
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
    const dbConfig = loadDbConfig();
    const pool = new Pool({ connectionString: dbConfig.url });
    attachDatabasePool(pool);
    const deps = createDeps({ db: wrapPool(pool), routes: "hosted" });
    handler = createHandler(deps, loadDeploymentOrigin());
  }
  return handler;
}

export default {
  fetch: (request: Request): Promise<Response> => getHandler()(request),
};
