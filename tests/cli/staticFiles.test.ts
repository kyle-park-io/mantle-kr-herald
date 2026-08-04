// tests/cli/staticFiles.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStatic } from "../../src/cli/staticFiles";

/**
 * `serve:hosted` serves the built SPA itself, standing in for the static layer Vercel owns on the
 * real deployment. Two things went wrong in the first version of that, both found by pointing a
 * browser at it (`pnpm serve:hosted`, DEPLOY.md §5-1) rather than by any test:
 *
 * 1. It wrote the response headers BEFORE reading the file — `res.writeHead(200, …).end(await
 *    readFile(…))` evaluates the receiver first — so a missing file left headers already sent, and
 *    the `index.html` fallback's second `writeHead` threw `ERR_HTTP_HEADERS_SENT` out of the
 *    request handler and killed the process. One `GET /favicon.ico`, which every browser sends
 *    unprompted, was enough. The SPA fallback died on the exact case it exists for.
 * 2. It joined the request path onto the dist directory with no containment check, so
 *    `GET /../../package.json` returned the repo's own file with a 200.
 *
 * Reading is therefore separated from responding: this function does all the IO and all the path
 * resolution, and hands back bytes or nothing. A caller that only writes headers once it holds a
 * result cannot reproduce (1), and cannot reach outside `distDir` to reproduce (2).
 */

let dist: string;

beforeAll(async () => {
  dist = await mkdtemp(join(tmpdir(), "herald-static-"));
  await writeFile(join(dist, "index.html"), "<!doctype html>INDEX");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(dist, "assets", "app-abc123.css"), "body{}");
});

afterAll(async () => {
  await rm(dist, { recursive: true, force: true });
});

describe("readStatic", () => {
  it("serves index.html at the root", async () => {
    const file = await readStatic(dist, "/");
    expect(file?.body.toString()).toContain("INDEX");
    expect(file?.contentType).toBe("text/html; charset=utf-8");
  });

  it("serves a hashed asset with its own content type", async () => {
    expect((await readStatic(dist, "/assets/app-abc123.js"))?.contentType).toBe("text/javascript; charset=utf-8");
    expect((await readStatic(dist, "/assets/app-abc123.css"))?.contentType).toBe("text/css; charset=utf-8");
  });

  it("falls back to index.html for a path the SPA router owns", async () => {
    const file = await readStatic(dist, "/renderings");
    expect(file?.body.toString()).toContain("INDEX");
  });

  // The regression: this is the request a browser makes on its own, and it used to end the process.
  it("falls back rather than failing when a file is simply absent", async () => {
    const file = await readStatic(dist, "/favicon.ico");
    expect(file?.body.toString()).toContain("INDEX");
  });

  it("refuses to escape the dist directory", async () => {
    // Resolves outside `dist` — served verbatim before, with a 200.
    const file = await readStatic(dist, "/../../package.json");
    expect(file?.body.toString()).not.toContain("mantle-kr-herald");
    expect(file?.body.toString()).toContain("INDEX");
  });

  it("returns nothing when there is no build at all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "herald-empty-"));
    try {
      expect(await readStatic(empty, "/")).toBeUndefined();
      expect(await readStatic(empty, "/anything")).toBeUndefined();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("does not mistake a directory for a file", async () => {
    // `readFile` on a directory rejects with EISDIR; that must fall back, not propagate.
    const file = await readStatic(dist, "/assets");
    expect(file?.body.toString()).toContain("INDEX");
  });
});
