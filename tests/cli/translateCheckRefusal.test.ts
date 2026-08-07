import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `src/cli/translate-check.ts` is a top-level script — running it opens a database connection — so
 * its refusal is pinned at the source level, the way `tests/deploy/` pins scripts it cannot run.
 *
 * What is being protected: an empty glossary makes every comparison vacuous, and the command's own
 * success line ("no drift found") then reads as a pass. That is not hypothetical — the very first
 * run of this command printed it, from a git worktree, because `translation/` is git-ignored and a
 * worktree receives only the `*.example.*` files. The command must refuse before it can say that.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("../../src/cli/translate-check.ts", import.meta.url)), "utf8");

describe("translate:check refuses an empty glossary", () => {
  it("throws on a zero-entry glossary", () => {
    expect(SOURCE).toMatch(/if \(glossary\.length === 0\) \{\s*\n\s*throw new Error\(/);
  });

  it("refuses before it can print a clean result", () => {
    // Anchored on the `console.log` that actually prints it, not on any mention of the phrase — the
    // refusal's own comment quotes it, and matching that would have compared the guard against its
    // own explanation.
    const refusalAt = SOURCE.indexOf("glossary.length === 0");
    const cleanAt = SOURCE.indexOf('console.log("no drift found.")');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(cleanAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(cleanAt);
  });

  it("warns against config:init, which would write skeletons over the real glossary", () => {
    // doctor's own hint says to run it, and that hint is wrong for this case — it replaces a real
    // 96-term glossary with an empty one. Recorded in the message so nobody follows it here.
    expect(SOURCE).toContain("config:init");
  });
});
