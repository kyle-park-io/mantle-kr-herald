import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";
import { ALL_OUTLETS } from "../../src/domain/outlet/models";

/**
 * Standard runtime variables that are never ours to document — the app does not define them and a
 * user does not set them in `.env`.
 */
const NOT_OURS = new Set(["NODE_ENV", "CI", "HOME", "PATH"]);

const TAGS = ["[REQUIRED", "[OPTIONAL", "[PICK ONE"];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

async function readEnvVars(): Promise<Set<string>> {
  const text = await readFile(join(REPO_ROOT, ".env.example"), "utf8");
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

async function readCodeVars(): Promise<Set<string>> {
  // `api/` (the Vercel entry point) is a second source root, outside `src/` — nothing in it reads
  // `process.env` directly today (everything goes through `src/config.ts`'s loaders), but scanning
  // only `src/` would let a future direct read there go undocumented with this test still green.
  const files = [...(await sourceFiles(join(REPO_ROOT, "src"))), ...(await sourceFiles(join(REPO_ROOT, "api")))];
  const used = new Set<string>();
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!NOT_OURS.has(m[1])) used.add(m[1]);
    }
  }
  // src/config.ts resolves each outlet's chat id via a dynamic `process.env[outlet.chatIdEnv]`
  // lookup, which the static regex above cannot see. ALL_OUTLETS is the single source of truth
  // for which env var each outlet reads (src/domain/outlet/models.ts), so pull the names
  // straight from there instead of hand-maintaining a second list in this test.
  for (const outlet of ALL_OUTLETS) {
    if (outlet.chatIdEnv) used.add(outlet.chatIdEnv);
  }
  return used;
}

describe(".env.example", () => {
  it("documents every environment variable the code reads", async () => {
    const [documented, used] = await Promise.all([readEnvVars(), readCodeVars()]);
    const undocumented = [...used].filter((v) => !documented.has(v)).sort();
    expect(undocumented, "src/ reads these but .env.example never mentions them").toEqual([]);
  });

  it("has no entries the code never reads", async () => {
    const [documented, used] = await Promise.all([readEnvVars(), readCodeVars()]);
    const unused = [...documented].filter((v) => !used.has(v)).sort();
    expect(unused, ".env.example lists these but no source file reads them").toEqual([]);
  });

  it("tags every variable REQUIRED, OPTIONAL or PICK ONE", async () => {
    const lines = (await readFile(join(REPO_ROOT, ".env.example"), "utf8")).split("\n");
    const isVar = (s: string): boolean => /^[A-Z][A-Z0-9_]*=/.test(s);
    const untagged: string[] = [];

    for (const [i, line] of lines.entries()) {
      if (!isVar(line)) continue;
      // Walk up to the comment block introducing this variable. Sibling variable lines are
      // skipped so a credential pair may share one tag above the group.
      const block: string[] = [];
      for (let j = i - 1; j >= 0; j--) {
        const s = lines[j];
        if (isVar(s)) continue;
        if (s.startsWith("#")) {
          block.push(s);
          continue;
        }
        if (s.trim() === "" && block.length === 0) continue;
        break;
      }
      if (!TAGS.some((t) => block.join(" ").includes(t))) untagged.push(line.split("=")[0]);
    }
    expect(untagged, "every variable needs a [REQUIRED]/[OPTIONAL]/[PICK ONE] tag above it").toEqual([]);
  });
});
