// tests/deploy/vercelignore.test.ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { REPO_ROOT } from "../../src/paths";

/**
 * `npx vercel deploy --prod` uploads the local directory, and `.vercelignore` decides what of it.
 * Getting that wrong is unusually quiet: on 2026-08-05 the first version of the file used gitignore
 * patterns without a leading slash, so `conversion/` and `translation/` — meant to drop the two
 * steering corpora at the repo root — also matched `src/domain/conversion/` and
 * `src/domain/translation/` at depth. The deploy reported success, the SPA served a 200, and every
 * single API request died with
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/src/adapters/db/createDb'
 *
 * because the bundler had no `src/` to inline. Nothing before the deploy could have caught it:
 * `pnpm test`, `pnpm typecheck` and `pnpm deploy:check` all read the working tree, where those files
 * plainly exist.
 *
 * So the invariant is checked here instead: whatever `.vercelignore` says, every file the function
 * and the web build actually need must survive it, and the two things that must never ship must not.
 */

/** Everything the deployment cannot be built or run without. */
const REQUIRED_DIRS = ["api", "src", "web/src"];
const REQUIRED_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "web/index.html",
  "web/tsconfig.json",
  "web/vite.config.ts",
];

/** Must never be uploaded. A private key and every live credential. */
const MUST_BE_IGNORED = ["keys/mantle-sa.json", ".env", "output/publish/state.json"];

/**
 * Unanchored directory patterns that are deliberate: a nested one is the same mistake as a root one.
 * Anything else must carry a leading slash, which is the whole lesson of the incident above.
 */
const INTENTIONALLY_UNANCHORED = new Set(["node_modules/"]);

interface Pattern {
  raw: string;
  anchored: boolean;
  directory: boolean;
  /** Path with the leading `/` and trailing `/` stripped. */
  body: string;
}

function parse(source: string): Pattern[] {
  return source
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((raw) => {
      const anchored = raw.startsWith("/");
      const directory = raw.endsWith("/");
      const body = raw.replace(/^\//, "").replace(/\/$/, "");
      return { raw, anchored, directory, body };
    });
}

/** True when `path` (repo-relative, `/`-separated) is excluded by `p`. */
function matches(p: Pattern, path: string): boolean {
  const segments = path.split("/");
  if (p.directory) {
    return p.anchored ? path === p.body || path.startsWith(`${p.body}/`) : segments.slice(0, -1).includes(p.body);
  }
  if (p.body.includes("*")) {
    // Only the `*.ext` form is used, and the syntax guard below keeps it that way.
    const re = new RegExp(`^${p.body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return p.anchored ? re.test(path) : segments.some((s) => re.test(s));
  }
  return p.anchored ? path === p.body : segments.includes(p.body);
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(relative(REPO_ROOT, full).split(sep).join("/"));
  }
  return acc;
}

describe(".vercelignore", () => {
  const load = async () => parse(await readFile(join(REPO_ROOT, ".vercelignore"), "utf8"));

  /**
   * The matcher above understands a deliberately small subset. A pattern outside it would be checked
   * by rules it does not obey, and this file would report a green that means nothing — so the file is
   * held to the subset rather than the matcher being grown to meet it.
   */
  it("uses only the pattern syntax this test can evaluate", async () => {
    for (const p of await load()) {
      expect(p.raw, `${p.raw}: negation is not evaluated here`).not.toMatch(/^!/);
      expect(p.raw, `${p.raw}: '**', '?' and character classes are not evaluated here`).not.toMatch(/\*\*|\?|\[/);
      // A slash in the middle only means something anchored; unanchored ones are a trap.
      if (p.body.includes("/")) expect(p.anchored, `${p.raw}: a multi-segment pattern must be anchored`).toBe(true);
    }
  });

  it("anchors every directory pattern", async () => {
    for (const p of await load()) {
      if (!p.directory || INTENTIONALLY_UNANCHORED.has(p.raw)) continue;
      expect(
        p.anchored,
        `${p.raw} has no leading slash, so it matches a directory of that name at ANY depth — ` +
          `this is how src/domain/conversion and src/domain/translation were dropped from the first deploy`,
      ).toBe(true);
    }
  });

  it("keeps every file the function and the web build need", async () => {
    const patterns = await load();
    const files = [...REQUIRED_FILES];
    for (const dir of REQUIRED_DIRS) files.push(...(await walk(join(REPO_ROOT, dir))));

    const dropped = files.filter((f) => patterns.some((p) => matches(p, f)));
    expect(dropped, `these would not be uploaded: ${dropped.slice(0, 10).join(", ")}`).toEqual([]);
  });

  it("drops the credentials and the pipeline data", async () => {
    const patterns = await load();
    for (const path of MUST_BE_IGNORED) {
      expect(
        patterns.some((p) => matches(p, path)),
        `${path} would be uploaded to Vercel`,
      ).toBe(true);
    }
  });
});
