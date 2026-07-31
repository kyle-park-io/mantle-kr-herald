// tests/adapters/web/httpServer.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../src/adapters/web/HttpServer";
import type { ApiDeps } from "../../../src/adapters/web/apiHandlers";
import { SESSION_COOKIE_NAME } from "../../../src/adapters/web/sessionCookie";
import { signSession } from "../../../src/domain/auth/session";
import { fakeDeps, fakeRenderingDeps, fakeBoardDeps, fakeConvertFormatDeps, TEST_SESSION_SECRET } from "../../support/fakeApiDeps";

const servers: import("node:http").Server[] = [];
afterEach(() => servers.forEach((s) => s.close()));

/**
 * Writes `head` (and, optionally, `body`) over a raw TCP socket and collects whatever the server
 * sends back until the connection closes. A real HTTP client can't express what these tests need:
 * "declare a huge Content-Length but never finish sending it" (to prove the server answers without
 * waiting to read a body it was always going to refuse) or "stop writing partway through a body
 * that's over a server-side cap" (to prove the server stops reading, and answers, right at the cap
 * rather than after buffering everything the client felt like sending).
 */
function rawRequest(port: number, head: string, body?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(head);
      if (body) socket.write(body);
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for a response — the server may have blocked reading the body"));
    }, 3000);
    socket.on("data", (c) => chunks.push(c));
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.on("error", () => {
      // A server-initiated `req.destroy()` can surface as ECONNRESET on this side; `close` still
      // follows and is what actually resolves this — swallow the error rather than reject a
      // request that already got its answer.
    });
  });
}

/**
 * A signed, currently-valid cookie header — every test below that expects a real route to run (not
 * merely to be gated) needs one, since `fakeDeps()`'s own `session` field is irrelevant here: it is
 * always overwritten per request by `HttpServer` from the real `Cookie` header, exactly as it is in
 * production.
 */
const authCookieHeader = (): Record<string, string> => ({
  Cookie: `${SESSION_COOKIE_NAME}=${signSession({ issuedAt: new Date().toISOString() }, TEST_SESSION_SECRET)}`,
});

async function start(staticDir: string, localPublishDir = staticDir) {
  const server = startServer(fakeDeps(), { port: 0, staticDir, localPublishDir });
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("startServer", () => {
  it("serves the API as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const base = await start(dir);
    const res = await fetch(`${base}/api/translations`, { headers: authCookieHeader() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { itemId: string }[])[0].itemId).toBe("x:1");
  });

  describe("the session gate", () => {
    it("answers 401 for an API request with no session cookie — reads included, the board is not public", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const base = await start(dir);

      const res = await fetch(`${base}/api/translations`);

      expect(res.status).toBe(401);
    });

    // `session.test.ts` proves `verifySession` itself rejects a forged token at the unit level;
    // this proves `currentSession` actually passes that verdict through rather than, say, granting
    // a session to any request that merely carries *a* cookie by this name.
    it("answers 401 for an API request with a tampered session cookie", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const base = await start(dir);

      const res = await fetch(`${base}/api/translations`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=garbage` } });

      expect(res.status).toBe(401);
    });

    // `session.test.ts` proves `verifySession` itself enforces a `ttlMs` shorter than the 12h
    // default; this proves `HttpServer` actually threads `sessionConfig.ttlMs` through rather than
    // handing `verifySession` nothing and letting it fall back to `SESSION_TTL_MS` regardless —
    // against the old, inert plumbing this cookie (2s old, under a 1s `ttlMs`) would still verify
    // fine and this would answer 200.
    it("rejects a session older than sessionConfig.ttlMs, even though it is well under the 12h default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const deps = fakeDeps();
      deps.sessionConfig = { secret: TEST_SESSION_SECRET, ttlMs: 1_000 };
      const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
      servers.push(server);
      await new Promise((r) => server.once("listening", r));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;

      const staleIssuedAt = new Date(Date.now() - 2_000).toISOString();
      const token = signSession({ issuedAt: staleIssuedAt }, TEST_SESSION_SECRET);

      const res = await fetch(`${base}/api/translations`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } });

      expect(res.status).toBe(401);
    });

    it("POST /api/login sets a session cookie with the right attributes on success", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const deps = fakeDeps();
      deps.login = async () => ({ ok: true });
      const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
      servers.push(server);
      await new Promise((r) => server.once("listening", r));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;

      const res = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "herald", password: "pw" }),
      });

      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      // Max-Age matches the token's own lifetime (SESSION_TTL_MS, 12h) in seconds.
      expect(cookie).toContain(`Max-Age=${12 * 60 * 60}`);
    });

    it("POST /api/logout clears the session cookie", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const base = await start(dir);

      const res = await fetch(`${base}/api/logout`, { method: "POST", headers: authCookieHeader() });

      expect(res.status).toBe(200);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
      expect(cookie).toContain("Max-Age=0");
    });

    // A status-only assertion here would pass even if the old, buggy code path were restored: that
    // code also eventually answered 401, just after fully reading and concatenating the body first.
    // This proves the gate runs BEFORE `readBody` by making a body-read impossible to complete: the
    // request declares a 20 MB body and the socket never sends a single byte of it. If the server
    // ever tried to read the body before checking the session, it would sit waiting for bytes that
    // are never coming and this test would time out instead of getting a prompt 401.
    it("401s a PUT with no session cookie without ever reading its (declared) body", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const base = await start(dir);
      const { port } = new URL(base);

      const declaredLength = 20 * 1024 * 1024;
      const head =
        `PUT /api/translations/x%3A1 HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${declaredLength}\r\n` +
        `Connection: close\r\n\r\n`;

      const response = await rawRequest(Number(port), head);

      expect(response).toContain(" 401 ");
      expect(response).toContain("unauthenticated");
    });

    // The same body-read guard as above extends past the session gate: even an authenticated write
    // must not let the server buffer an unbounded body. This sends real bytes past the 2 MiB cap
    // (`MAX_API_BODY_BYTES`) but stops well short of the 10 MB the request declares — if the server
    // answers here rather than after 10 MB arrive, it stopped reading at the cap, not at the
    // client's own Content-Length.
    it("answers 413 for an authenticated body over the cap, without waiting for the rest of it", async () => {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
      const base = await start(dir);
      const { port } = new URL(base);
      const cookie = `${SESSION_COOKIE_NAME}=${signSession({ issuedAt: new Date().toISOString() }, TEST_SESSION_SECRET)}`;

      const overCap = Buffer.alloc(2 * 1024 * 1024 + 1024, "a");
      const declaredLength = 10 * 1024 * 1024;
      const head =
        `PUT /api/translations/x%3A1 HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\n` +
        `Content-Type: application/json\r\n` +
        `Cookie: ${cookie}\r\n` +
        `Content-Length: ${declaredLength}\r\n` +
        `Connection: close\r\n\r\n`;

      const response = await rawRequest(Number(port), head, overCap);

      expect(response).toContain(" 413 ");
      expect(response).toContain("request body too large");
    });
  });

  it("serves index.html for a non-API path (SPA fallback)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>dash</title>");
    const base = await start(dir);
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain("dash");
  });

  it("forwards the parsed PUT body to the use-case", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const savedInputs: unknown[] = [];
    const deps: ApiDeps = {
      translationStore: {
        loadAll: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }],
        upsert: async () => {},
        listTranslatedIds: async () => new Set(),
      },
      saveTranslation: {
        run: async (input: unknown) => {
          savedInputs.push(input);
          return { itemId: "x:1", promoted: false };
        },
      } as unknown as ApiDeps["saveTranslation"],
      publishOne: async () => ({ uploaded: 0, updated: 0, failed: 0, failures: [], byDrive: {} }),
      storageMode: "cloud",
      ...fakeRenderingDeps(),
      ...fakeBoardDeps(),
      ...fakeConvertFormatDeps(),
      loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { synced: 0, needsRepublish: 0, unpublished: 0 }, availableTargets: ["local"], integrations: [], sheetLinks: {}, dbEnv: "development" }),
      loadPublishState: async () => [],
      loadTranslations: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }],
      xMaxWeighted: 280,
      loadQuota: async () => ({ error: "not configured" }),
      login: async () => ({ ok: false, retryAfterMs: 0 }),
      sessionConfig: { secret: TEST_SESSION_SECRET, ttlMs: 1000 },
      session: undefined,
    };
    const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/translations/x%3A1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authCookieHeader() },
      body: JSON.stringify({ koreanText: "새 번역" }),
    });

    expect(res.status).toBe(200);
    expect((savedInputs[0] as { koreanText: string }).koreanText).toBe("새 번역");
  });

  // Authenticated — see "returns a generic 500 body" below for the one unauthenticated route.
  it("returns a clean 500 error body when a dependency throws (no crash)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const deps: ApiDeps = {
      translationStore: {
        loadAll: async () => {
          throw new Error("boom");
        },
        upsert: async () => {},
        listTranslatedIds: async () => new Set(),
      },
      saveTranslation: { run: async () => ({ itemId: "x:1", promoted: false }) } as unknown as ApiDeps["saveTranslation"],
      publishOne: async () => ({ uploaded: 0, updated: 0, failed: 0, failures: [], byDrive: {} }),
      storageMode: "cloud",
      ...fakeRenderingDeps(),
      ...fakeBoardDeps(),
      ...fakeConvertFormatDeps(),
      loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { synced: 0, needsRepublish: 0, unpublished: 0 }, availableTargets: ["local"], integrations: [], sheetLinks: {}, dbEnv: "development" }),
      loadPublishState: async () => [],
      loadTranslations: async () => {
        throw new Error("boom");
      },
      xMaxWeighted: 280,
      loadQuota: async () => ({ error: "not configured" }),
      login: async () => ({ ok: false, retryAfterMs: 0 }),
      sessionConfig: { secret: TEST_SESSION_SECRET, ttlMs: 1000 },
      session: undefined,
    };
    const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/translations`, { headers: authCookieHeader() });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("boom");
  });

  /**
   * `POST /api/login` is the one route reachable with no session, and it reaches live database
   * queries through `Login` → `PgAttemptLimiter`. A driver failure there (a bad `DATABASE_URL`, an
   * unmigrated schema, a rejected password) must not repeat the detailed body the authenticated case
   * above gets — that would hand an unauthenticated caller the driver's own text: schema names,
   * internal hostnames, database usernames. Same bar the 401 elsewhere on this route already holds
   * itself to: no detail about why.
   */
  it("returns a generic 500 body — not the driver's own text — when POST /api/login's dependency throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const deps = fakeDeps();
    deps.login = async () => {
      throw new Error('relation "auth_attempts" does not exist');
    };
    const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "herald", password: "pw" }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("auth_attempts");
    expect(body.error).not.toContain("relation");
  });

  it("serves a local publish file as text/markdown", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    await mkdir(join(pubDir, "approved"), { recursive: true });
    await writeFile(join(pubDir, "approved", "doc.md"), "# 발행본\n본문");
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/approved/doc.md`, { headers: authCookieHeader() });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# 발행본\n본문");
  });

  // This route bypasses `handleApi` entirely (its own branch in `HttpServer.ts`), so it needs its
  // own gate check rather than inheriting the one `handleApi` runs — this proves that check is
  // actually there, not just the one inside `handleApi`.
  it("answers 401 for a local publish file with no session cookie", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    await mkdir(join(pubDir, "approved"), { recursive: true });
    await writeFile(join(pubDir, "approved", "doc.md"), "# 발행본\n본문");
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/approved/doc.md`);

    expect(res.status).toBe(401);
  });

  it("returns 404 for a traversal attempt, reading nothing outside the root", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/../../etc/passwd`, { headers: authCookieHeader() });

    expect(res.status).toBe(404);
  });

  // A literal "../../" is already collapsed by the URL parser before it reaches the route
  // (the request falls through to the generic /api/ 404 instead). An encoded slash (%2f)
  // survives URL parsing untouched, so this is what actually exercises the route's own
  // decode + strip + resolve guard.
  it("returns 404 for an encoded-slash traversal attempt, reading nothing outside the root", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/..%2f..%2fetc%2fpasswd`, { headers: authCookieHeader() });

    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing local publish file (not the SPA fallback)", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>dash</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/nope.md`, { headers: authCookieHeader() });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("dash");
  });

  it("returns 404 (not 500) for a malformed percent-encoded local path", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/%zz`, { headers: authCookieHeader() });

    expect(res.status).toBe(404);
  });

  /**
   * The session gate alone is not enough here: a signed-in operator's browser still holds a valid
   * cookie, and `SameSite=Lax` is what a browser decides is "top-level," not something this server
   * controls. `POST /api/outlets/:itemId/:type/:outletId/send` takes no body — a *simple* cross-site
   * request, so no preflight stands between a page the operator happens to have open (with a live
   * session) and a live post to a real Telegram room. Loopback binding and a guessed `itemId` make it
   * impractical, not impossible; these tests hold the guard in place.
   */
  describe("cross-site guard", () => {
    /** A server whose send route records its calls, so a refusal is shown to reach no use case. */
    async function startCounting() {
      const dir = await mkdtemp(join(tmpdir(), "web-"));
      await writeFile(join(dir, "index.html"), "<!doctype html><title>dash</title>");
      const sends: string[] = [];
      const deps = fakeDeps();
      deps.sendToOutlet = async (itemId: string, _type: string, outletId: string) => {
        sends.push(`${itemId}:${outletId}`);
        return { sent: 1, failed: 0 };
      };
      const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
      servers.push(server);
      await new Promise((r) => server.once("listening", r));
      const { port } = server.address() as AddressInfo;
      return { base: `http://127.0.0.1:${port}`, sends };
    }

    const send = (base: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/outlets/x%3A1/announcement/tg-dev/send`, { method: "POST", headers });

    it("refuses a send whose Origin is another site, without reaching the use case", async () => {
      const { base, sends } = await startCounting();
      const res = await send(base, { Origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect(sends).toEqual([]);
    });

    // A sandboxed iframe or a `file://` page sends `Origin: null`. It is not this machine.
    it("refuses a send from an opaque origin", async () => {
      const { base, sends } = await startCounting();
      const res = await send(base, { Origin: "null" });
      expect(res.status).toBe(403);
      expect(sends).toEqual([]);
    });

    it("allows the dashboard's own send (same-origin, and the no-Origin case)", async () => {
      const { base, sends } = await startCounting();
      expect((await send(base, { Origin: base, ...authCookieHeader() })).status).toBe(200);
      expect((await send(base, authCookieHeader())).status).toBe(200);
      expect(sends).toHaveLength(2);
    });

    // `pnpm dev:web` serves the UI from Vite on :5173 and proxies /api here with the browser's own
    // Origin intact, so the guard cannot key on this server's own port.
    it("allows a send proxied from the Vite dev server on another loopback port", async () => {
      const { base, sends } = await startCounting();
      expect((await send(base, { Origin: "http://localhost:5173", ...authCookieHeader() })).status).toBe(200);
      expect(sends).toHaveLength(1);
    });

    // The one shape a cross-site HTML form can post. Refused even with no Origin at all.
    it("refuses a form-encoded state-changing request", async () => {
      const { base, sends } = await startCounting();
      const res = await send(base, { "Content-Type": "application/x-www-form-urlencoded" });
      expect(res.status).toBe(403);
      expect(sends).toEqual([]);
    });

    it("leaves reads alone — a foreign Origin on a GET still serves", async () => {
      const { base } = await startCounting();
      const res = await fetch(`${base}/api/translations`, { headers: { Origin: "https://evil.example", ...authCookieHeader() } });
      expect(res.status).toBe(200);
    });
  });

  it("serves a .woff2 font with the font/woff2 content-type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    const base = await start(dir);

    const res = await fetch(`${base}/assets/font.woff2`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
  });
});
