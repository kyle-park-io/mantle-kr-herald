// tests/docs/koDocs.test.ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { REPO_ROOT } from "../../src/paths";

/**
 * `docs/ko/` is the user-facing documentation, and Korean is the source of truth for it
 * (`docs/ko/README.md`). Two things in it rot silently, both of which waste a reader's time in the
 * worst possible moment — while they are following instructions:
 *
 * 1. a command that no longer exists, because a `package.json` script was renamed
 * 2. a link to a document that moved or was never written
 *
 * Neither shows up in a typecheck or in any other test. `docs/ko/deploy.md` was split out of an
 * untracked runbook on 2026-08-05 and cross-links `setup/vercel.md` in both directions, which is
 * exactly the arrangement that starts drifting the moment either file moves.
 *
 * Only fenced code blocks are checked for commands. Prose legitimately names commands that do not
 * exist — `setup/vercel.md` says "별도의 `pnpm db:schema` 명령은 없습니다" precisely to tell the
 * reader so — and a check that cannot tell those apart would have to be switched off.
 */

const PNPM_BUILTINS = new Set([
  "install", "add", "remove", "dlx", "exec", "run", "why", "store", "up", "outdated", "link", "init",
]);

async function markdownFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await markdownFiles(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

const koDocs = () => markdownFiles(join(REPO_ROOT, "docs", "ko"));
const short = (path: string) => relative(REPO_ROOT, path).split(sep).join("/");

/** The contents of every ``` fenced block — what a reader actually copies. */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe("docs/ko", () => {
  it("only tells the reader to run commands that exist", async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const missing: string[] = [];

    for (const file of await koDocs()) {
      const source = await readFile(file, "utf8");
      for (const block of codeBlocks(source)) {
        for (const match of block.matchAll(/\bpnpm ([a-z][a-z0-9:_-]*)/g)) {
          const script = match[1];
          if (PNPM_BUILTINS.has(script) || script in pkg.scripts) continue;
          missing.push(`${short(file)} → pnpm ${script}`);
        }
      }
    }

    expect([...new Set(missing)], "these commands are documented but not in package.json").toEqual([]);
  });

  it("has no broken links between its own documents", async () => {
    const broken: string[] = [];

    for (const file of await koDocs()) {
      const source = await readFile(file, "utf8");
      // `](path.md)` and `](path.md#anchor)`, skipping absolute URLs.
      for (const match of source.matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/g)) {
        const target = match[1];
        if (/^https?:/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target))) broken.push(`${short(file)} → ${target}`);
      }
    }

    expect(broken, "these links point at files that do not exist").toEqual([]);
  });

  /**
   * The index is how a reader finds anything here at all; a document missing from it is a document
   * nobody opens. Checked against the directory rather than a hand-kept list, so adding a file to
   * `docs/ko/` is what makes this fail.
   */
  it("lists every top-level document in its README", async () => {
    const readme = await readFile(join(REPO_ROOT, "docs", "ko", "README.md"), "utf8");
    const top = (await readdir(join(REPO_ROOT, "docs", "ko"), { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "README.md")
      .map((e) => e.name);

    const unlisted = top.filter((name) => !readme.includes(name));
    expect(unlisted, "add these to docs/ko/README.md's 문서 지도").toEqual([]);
  });
});
