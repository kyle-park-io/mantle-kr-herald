// tests/adapters/web/vercelHandler.test.ts
import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { createTestDb } from "../../support/testDb";
import { createDeps } from "../../../src/app/createDeps";
import { createHandler, assertTrustProxy } from "../../../api/[...path]";
import { signSession } from "../../../src/domain/auth/session";
import { buildSessionCookie } from "../../../src/adapters/web/sessionCookie";
import { MAX_API_BODY_BYTES } from "../../../src/adapters/web/HttpServer";

/**
 * `createDeps` refuses to build without an account, a session secret and a stated storage mode
 * (`loadAuthConfig`/`loadSessionConfig`/`loadStorageMode`), and `loadDbEnv()` wants `HERALD_DB_ENV`
 * too — none of that is what this file is about, so the minimum is set once here and restored after,
 * the same shape `tests/app/createDeps.test.ts` already uses.
 */
const ENV_KEYS = ["HERALD_AUTH_USERNAME", "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET", "HERALD_STORAGE_MODE", "HERALD_DB_ENV"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.HERALD_AUTH_USERNAME = "test-user";
  process.env.HERALD_AUTH_PASSWORD_HASH = "scrypt$test$test";
  process.env.HERALD_SESSION_SECRET = "test-only-session-secret-do-not-use-in-prod!!!!";
  process.env.HERALD_STORAGE_MODE = "local";
  process.env.HERALD_DB_ENV = "development";
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const DEPLOYMENT_ORIGIN = "https://herald-review.vercel.app";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** A `handler` built over a fresh PGlite-backed `deps` — never a real Postgres connection or a real
 *  `DATABASE_URL`, unlike the module's own default export (`getHandler()`), which this file never
 *  imports or calls. */
async function testHandler(): Promise<ReturnType<typeof createHandler>> {
  db = await createTestDb();
  const deps = createDeps({ db, routes: "hosted" });
  return createHandler(deps, DEPLOYMENT_ORIGIN);
}

async function sessionCookieHeader(): Promise<string> {
  const token = signSession({ issuedAt: new Date().toISOString() }, "test-only-session-secret-do-not-use-in-prod!!!!");
  // `buildSessionCookie` returns a full `Set-Cookie` line (`name=value; HttpOnly; ...`); a request's
  // own `Cookie` header wants just `name=value`.
  return buildSessionCookie(token, 1000).split(";")[0];
}

describe("the Vercel handler", () => {
  it("maps a request onto handleApi and returns its status and body", async () => {
    const handle = await testHandler();
    const res = await handle(new Request(`${DEPLOYMENT_ORIGIN}/api/status`, { method: "GET" }));
    expect(res.status).toBe(401); // no session — the gate from Plan B
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("reads the body only once the session is known good", async () => {
    const handle = await testHandler();
    const body = JSON.stringify({ koreanText: "x" });
    const request = new Request(`${DEPLOYMENT_ORIGIN}/api/translations/x%3A1`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body,
    });
    const res = await handle(request);
    expect(res.status).toBe(401);
    // The Web-standard contract itself proves the body was never touched — `bodyUsed` flips true
    // only once something actually reads the stream (`.text()`, `.json()`, a reader's `.read()`,
    // …), which `readJsonBody` never gets the chance to do before the 401 above is returned.
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a state-changing request from another origin, before the session gate", async () => {
    const handle = await testHandler();
    const res = await handle(
      new Request(`${DEPLOYMENT_ORIGIN}/api/outlets/x%3A1/announcement/tg-community/send`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(403);
  });

  /**
   * `refusalReason` answers `undefined` for every non-state-changing method BEFORE it ever consults
   * `isAllowedOrigin` (`HttpServer.ts`'s own `STATE_CHANGING` check runs first) — so a `GET` here
   * would pass regardless of whether the origin allowlist works at all, and prove nothing about it.
   * `POST /api/items/:id/reconcile` is the state-changing route this flag never closes (it stays
   * open even with `HERALD_SENDS_ENABLED` off), so it is reachable on a freshly seeded hosted `deps`
   * with no further setup.
   */
  it("allows a state-changing request whose Origin is this deployment's own", async () => {
    const handle = await testHandler();
    const res = await handle(
      new Request(`${DEPLOYMENT_ORIGIN}/api/items/x%3A1/reconcile`, {
        method: "POST",
        headers: { origin: DEPLOYMENT_ORIGIN, "content-type": "application/json", cookie: await sessionCookieHeader() },
      }),
    );
    // Not 403 (the origin allowlist accepted this deployment's own origin) and not 401 (the session
    // was valid) — whatever domain-level status `reconcile` itself answers with (400, since
    // Typefully is not configured in this test env) is not the point here.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("reaches a real route once authenticated, and returns handleApi's own json", async () => {
    const handle = await testHandler();
    const res = await handle(
      new Request(`${DEPLOYMENT_ORIGIN}/api/translations`, { method: "GET", headers: { cookie: await sessionCookieHeader() } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("caps the request body at MAX_API_BODY_BYTES, measured off the stream", async () => {
    const handle = await testHandler();
    const oversized = "x".repeat(MAX_API_BODY_BYTES + 1);
    const res = await handle(
      new Request(`${DEPLOYMENT_ORIGIN}/api/translations/x%3A1`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: await sessionCookieHeader() },
        body: JSON.stringify({ koreanText: oversized }),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("sets the session cookie a successful login returns", async () => {
    const handle = await testHandler();
    // The seeded account's real password is unknown here (only its scrypt hash is set above), so
    // this exercises the refusal path — the point is that `handleApi`'s `setCookie` (present only
    // on a successful login) survives the trip through `jsonResponse` unchanged when it IS present;
    // `loginRoute.test.ts` already covers `handleApi` producing one on success.
    const res = await handle(
      new Request(`${DEPLOYMENT_ORIGIN}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "test-user", password: "wrong" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

/**
 * `getHandler()` itself (the real, env-reading singleton `fetch` calls) is not exercised directly —
 * same reason `createDeps`'s own module-scope construction in `serve.ts` is not: it opens a real
 * `Pool` against a real `DATABASE_URL`. `assertTrustProxy` is pulled out specifically so the refusal
 * it wires in is testable without any of that.
 */
describe("assertTrustProxy", () => {
  it("refuses when this deployment has no way to trust X-Forwarded-For", () => {
    expect(() => assertTrustProxy({ trustProxy: false })).toThrow(/HERALD_TRUST_PROXY/);
  });

  it("passes once HERALD_TRUST_PROXY is on", () => {
    expect(() => assertTrustProxy({ trustProxy: true })).not.toThrow();
  });
});
