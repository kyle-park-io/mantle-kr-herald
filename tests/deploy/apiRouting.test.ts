// tests/deploy/apiRouting.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

/**
 * Vercel must route every `/api/*` path to the one Function, at any depth.
 *
 * It does not do this on its own. `api/[...path].ts` looks like a catch-all, but the zero-config
 * builder does not read `[...name]` that way — it treats it as a single dynamic segment literally
 * named `...path`. The routing table it generated for the 2026-08-05 deploy was:
 *
 *   { "src": "^/api/([^/]+)$", "dest": "/api/[...path]?...path=$1" }   <- one segment only
 *   { "src": "^/api(/.*)?$",   "status": 404 }                        <- everything else
 *
 * So `/api/status` reached the function and `/api/publish/state` was answered 404 by the edge, which
 * the function never saw. The board loaded, rendered its shell, and showed "해당하는 항목이 없습니다."
 * — the SPA could not tell an edge 404 from an empty board, so nothing looked broken.
 *
 * `vercel.json` now carries an explicit rewrite. This test derives the paths the browser actually
 * requests from `web/src/api.ts` and checks each one against that rewrite, so a route added to the
 * client later is covered without anyone remembering this file exists.
 *
 * Worth knowing while reading `deploy:smoke`: its `convert-prepare -> 404` check cannot catch this.
 * A missing route and an unrouted path both answer 404, and that path is three segments deep, so it
 * was 404 for the wrong reason and the check passed.
 */

/** Stand-ins for `${...}` in the client's template literals. Any non-empty segment does. */
const SAMPLE = { itemId: "x:123", type: "announcement", channel: "telegram", outletId: "tg-dev" };

async function clientPaths(): Promise<string[]> {
  const source = await readFile(join(REPO_ROOT, "web/src/api.ts"), "utf8");
  const found = new Set<string>();
  for (const m of source.matchAll(/["'`](\/api\/[^"'`]*)["'`]/g)) {
    let path = m[1];
    // `${encodeURIComponent(itemId)}` and friends -> a representative segment.
    path = path.replace(/\$\{[^}]*\bitemId\b[^}]*\}/g, SAMPLE.itemId);
    path = path.replace(/\$\{[^}]*\bid\b[^}]*\}/g, SAMPLE.itemId);
    path = path.replace(/\$\{\s*type\s*\}/g, SAMPLE.type);
    path = path.replace(/\$\{\s*channel\s*\}/g, SAMPLE.channel);
    path = path.replace(/\$\{\s*outletId\s*\}/g, SAMPLE.outletId);
    path = path.replace(/\$\{[^}]*\}/g, "segment");
    found.add(path.replace(/\?.*$/, ""));
  }
  return [...found].sort();
}

interface Rewrite {
  source: string;
  destination: string;
}

async function rewrites(): Promise<Rewrite[]> {
  const config = JSON.parse(await readFile(join(REPO_ROOT, "vercel.json"), "utf8")) as { rewrites?: Rewrite[] };
  return config.rewrites ?? [];
}

describe("Vercel API routing", () => {
  it("finds the API paths the browser requests", async () => {
    const paths = await clientPaths();
    // A guard on the guard: if this ever comes back empty the assertions below pass vacuously.
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.some((p) => p.split("/").length > 3), "expected at least one multi-segment path").toBe(true);
  });

  it("routes every one of them to the function, at any depth", async () => {
    const rules = await rewrites();
    expect(rules.length, "vercel.json has no rewrites — /api/a/b would be a 404 from the edge").toBeGreaterThan(0);

    for (const rule of rules) {
      expect(
        rule.source,
        `${rule.source}: path-to-regexp named parameters are not evaluated here — keep the source a plain regex`,
      ).not.toMatch(/:[A-Za-z]/);
    }

    const unmatched = (await clientPaths()).filter(
      (path) => !rules.some((rule) => new RegExp(`^${rule.source}$`).test(path)),
    );
    expect(
      unmatched,
      `no rewrite covers these, so Vercel's edge answers 404 before the function runs: ${unmatched.join(", ")}`,
    ).toEqual([]);
  });

  it("sends them to the function file that exists", async () => {
    for (const rule of await rewrites()) {
      expect(rule.destination).toBe("/api/[...path]");
    }
  });
});
