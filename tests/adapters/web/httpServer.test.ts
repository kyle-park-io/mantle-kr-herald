// tests/adapters/web/httpServer.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
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
   * The dashboard has no auth, and `POST /api/outlets/:itemId/:type/:outletId/send` takes no body —
   * a *simple* cross-site request, so no preflight stands between a page the operator happens to
   * have open and a live post to a real Telegram room. Loopback binding and a guessed `itemId` make
   * it impractical, not impossible; these tests hold the guard in place.
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
