// tests/deploy/functionBundle.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { REPO_ROOT } from "../../src/paths";

/**
 * The deployed Vercel Function must be a self-contained bundle. This is not a preference — it is the
 * only shape that runs.
 *
 * `package.json` declares `"type": "module"`, and `@vercel/node` reads that as "already ESM, do not
 * transpile to CJS": it compiles each `.ts` to `.js` in place and traces the tree with `@vercel/nft`,
 * rewriting no import specifiers. This repo writes relative imports without extensions — 1015 of
 * them, which `moduleResolution: "bundler"` and `tsx` both accept and Node's own ESM resolver does
 * not. So the first production deploy shipped `src/adapters/db/createDb.js` into the function
 * alongside an import of `"../src/adapters/db/createDb"`, and every request returned 500:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/adapters/db/createDb'
 *
 * Vercel's static layer kept serving the SPA with a 200 throughout, so nothing outside `/api/*`
 * looked wrong.
 *
 * `pnpm build:api` bundles `src/vercel/entry.ts` with `--packages=external`, which inlines every
 * relative import and leaves bare ones (`pg`, `node:*`) for Node to resolve normally. These tests
 * run that same bundle step and assert the property that makes the function work at all.
 */

/** The exact flags `pnpm build:api` uses. Kept in one place so the test cannot drift from the script. */
const BUNDLE_OPTIONS = {
  entryPoints: [join(REPO_ROOT, "src/vercel/entry.ts")],
  bundle: true,
  packages: "external" as const,
  platform: "node" as const,
  format: "esm" as const,
  target: "node22",
  write: false as const,
};

describe("the deployed function bundle", () => {
  it("inlines every relative import", async () => {
    const result = await build(BUNDLE_OPTIONS);
    const code = result.outputFiles[0].text;

    // `from "./x"` or `from "../x"` surviving into the output means Node will be asked to resolve a
    // path that may not exist and, extensionless, certainly will not.
    const relative = [...code.matchAll(/^\s*(?:import|export)[^;\n]*?from\s*"(\.[^"]*)"/gm)].map((m) => m[1]);
    expect(relative, `these would be resolved by Node at runtime, not by the bundler: ${relative.join(", ")}`).toEqual([]);
  });

  it("leaves runtime dependencies for Node to resolve", async () => {
    const result = await build(BUNDLE_OPTIONS);
    const code = result.outputFiles[0].text;
    // `--packages=external` is what keeps `pg` out of the bundle; without it esbuild would try to
    // inline a driver that expects to be resolved from node_modules.
    expect(code).toMatch(/from\s*"pg"/);
  });

  /**
   * The one specifier the bundler does not get to fix, because it is what Vercel compiles directly.
   * Without the extension this file reintroduces the original failure by itself.
   */
  it("re-exports the bundle from api/ with an explicit extension", async () => {
    const shim = await readFile(join(REPO_ROOT, "api/[...path].ts"), "utf8");
    const specifiers = [...shim.matchAll(/from\s*"(\.[^"]*)"/g)].map((m) => m[1]);

    expect(specifiers.length, "api/[...path].ts should re-export exactly one module").toBe(1);
    expect(specifiers[0], `${specifiers[0]} has no extension — Node's ESM resolver cannot resolve it`).toMatch(/\.js$/);
    expect(shim).toMatch(/export\s*\{[^}]*\bconfig\b[^}]*\}/);
    expect(shim).toMatch(/export\s*\{[^}]*\bdefault\b[^}]*\}/);
  });

  it("keeps the entry point out of api/, where Vercel would compile it unbundled", async () => {
    const shim = await readFile(join(REPO_ROOT, "api/[...path].ts"), "utf8");
    // A handler body back in `api/` is the regression: Vercel compiles that file itself, and no
    // build step of ours would get to bundle it.
    expect(shim).not.toMatch(/\bcreateHandler\s*\(/);
    expect(shim.split("\n").filter((l) => l.trim().startsWith("import ")).length).toBe(0);
  });
});
