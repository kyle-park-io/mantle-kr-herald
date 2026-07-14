// tests/adapters/web/httpServer.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../src/adapters/web/HttpServer";
import type { ApiDeps } from "../../../src/adapters/web/apiHandlers";

const servers: import("node:http").Server[] = [];
afterEach(() => servers.forEach((s) => s.close()));

function fakeDeps(): ApiDeps {
  return {
    translationStore: { loadAll: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }], upsert: async () => {}, listTranslatedIds: async () => new Set() },
    saveTranslation: { run: async () => ({ itemId: "x:1", promoted: false }) } as unknown as ApiDeps["saveTranslation"],
    buildPublisher: async () => ({ run: async () => ({ uploaded: 0, failed: 0, byDrive: {} }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>,
  };
}

async function start(staticDir: string) {
  const server = startServer(fakeDeps(), { port: 0, staticDir });
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
});
