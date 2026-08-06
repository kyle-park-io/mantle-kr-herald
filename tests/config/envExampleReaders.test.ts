// tests/config/envExampleReaders.test.ts
//
// `tests/config/envExample.test.ts` asserts that every variable the code reads is *present* in
// `.env.example` and vice versa. That is not the same as its description being true. Several entries
// enumerate which commands read them — "Used by `pnpm tm:measure`/`pnpm collect:reference` …" — and a
// presence check cannot notice a fourth reader appearing, which is exactly what happened when
// `pnpm x:reconcile` became one. Prose about a list of callers rots the first time someone adds one,
// so this turns that sentence into a check.
//
// Scoped to the variables whose comment actually makes that claim; adding a variable here is opting
// its comment into being enforced.
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

/** Variables whose `.env.example` comment enumerates the commands that read them. */
const ENUMERATING_VARS = ["REFERENCE_X_HANDLE"];

async function tsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tsFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** `src/cli/x-reconcile.ts` → `x:reconcile`, read off package.json rather than guessed from the
 *  filename (`metrics-record.ts` is `metrics:record`, but nothing guarantees that shape). */
async function scriptNameByCliFile(): Promise<Map<string, string>> {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const byFile = new Map<string, string>();
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const file = /(src\/cli\/[\w.-]+\.ts)/.exec(command)?.[1];
    if (file !== undefined && !byFile.has(file)) byFile.set(file, name);
  }
  return byFile;
}

/** The contiguous run of `#` comment lines immediately above `VAR=`. */
function commentBlockFor(example: string, variable: string): string {
  const lines = example.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`${variable}=`));
  if (at < 0) return "";
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].startsWith("#"); i--) block.unshift(lines[i]);
  return block.join("\n");
}

describe(".env.example comments that enumerate their readers", () => {
  it.each(ENUMERATING_VARS)("names every command that reads %s", async (variable) => {
    const example = await readFile(join(REPO_ROOT, ".env.example"), "utf8");
    const block = commentBlockFor(example, variable);
    expect(block, `${variable} has no comment block above it`).not.toBe("");

    const scripts = await scriptNameByCliFile();
    const readers: string[] = [];
    for (const file of await tsFiles(join(REPO_ROOT, "src"))) {
      const text = await readFile(file, "utf8");
      if (!text.includes(`process.env.${variable}`)) continue;
      // Only entry points have a script name to cite. A shared module reading the variable is a
      // different situation and is deliberately not asserted here.
      const script = scripts.get(file.slice(REPO_ROOT.length + 1));
      if (script !== undefined) readers.push(script);
    }

    expect(readers.length, `nothing under src/ reads ${variable}`).toBeGreaterThan(0);
    for (const script of readers) {
      expect(block, `${variable}'s comment does not mention pnpm ${script}`).toContain(script);
    }
  });
});
