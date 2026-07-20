// tests/adapters/web/httpServer.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../src/adapters/web/HttpServer";
import type { ApiDeps } from "../../../src/adapters/web/apiHandlers";

const servers: import("node:http").Server[] = [];
afterEach(() => servers.forEach((s) => s.close()));

// §7 renderings deps are irrelevant to these HttpServer-level tests (transport concerns
// only), so they're stubbed out identically wherever an ApiDeps literal is needed.
function fakeRenderingDeps(): Pick<ApiDeps, "formattingStore" | "conversionStore" | "saveRendering" | "approveRendering"> {
  return {
    formattingStore: { loadAll: async () => [], upsert: async () => {}, listRenderedKeys: async () => new Set() },
    conversionStore: { loadAll: async () => [], upsert: async () => {}, listConvertedKeys: async () => new Set() },
    saveRendering: { run: async () => ({ itemId: "x:1", type: "x", channel: "x" }) } as unknown as ApiDeps["saveRendering"],
    approveRendering: { run: async () => undefined } as unknown as ApiDeps["approveRendering"],
  };
}

function fakeDeps(): ApiDeps {
  return {
    translationStore: { loadAll: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }], upsert: async () => {}, listTranslatedIds: async () => new Set() },
    saveTranslation: { run: async () => ({ itemId: "x:1", promoted: false }) } as unknown as ApiDeps["saveTranslation"],
    buildPublisher: async () => ({ run: async () => ({ uploaded: 0, failed: 0, byDrive: {} }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>,
    storageMode: "cloud",
    ...fakeRenderingDeps(),
    loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { published: 0, unsynced: 0, stale: 0 } }),
    loadPublishState: async () => [],
  };
}

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
    const res = await fetch(`${base}/api/translations`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { itemId: string }[])[0].itemId).toBe("x:1");
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
      buildPublisher: async () => ({ run: async () => ({ uploaded: 0, failed: 0, byDrive: {} }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>,
      storageMode: "cloud",
      ...fakeRenderingDeps(),
      loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { published: 0, unsynced: 0, stale: 0 } }),
      loadPublishState: async () => [],
    };
    const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/translations/x%3A1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
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
      buildPublisher: async () => ({ run: async () => ({ uploaded: 0, failed: 0, byDrive: {} }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>,
      storageMode: "cloud",
      ...fakeRenderingDeps(),
      loadStatus: async () => ({ storageMode: "cloud", funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { published: 0, unsynced: 0, stale: 0 } }),
      loadPublishState: async () => [],
    };
    const server = startServer(deps, { port: 0, staticDir: dir, localPublishDir: dir });
    servers.push(server);
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/translations`);

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

    const res = await fetch(`${base}/api/publish/local/approved/doc.md`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# 발행본\n본문");
  });

  it("returns 404 for a traversal attempt, reading nothing outside the root", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/../../etc/passwd`);

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

    const res = await fetch(`${base}/api/publish/local/..%2f..%2fetc%2fpasswd`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing local publish file (not the SPA fallback)", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>dash</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/nope.md`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("dash");
  });

  it("returns 404 (not 500) for a malformed percent-encoded local path", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/%zz`);

    expect(res.status).toBe(404);
  });
});
