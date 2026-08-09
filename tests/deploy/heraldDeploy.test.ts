// tests/deploy/heraldDeploy.test.ts
//
// The script is read as text, the convention the rest of tests/deploy/ uses for shell and unit
// files. Two properties matter and neither is visible from the CLI's own tests: that the symlink is
// gone, and that the gate runs before the code moves. Gating after `git reset --hard origin/main`
// would refuse a deploy having already left the checkout on a commit nobody chose to deploy — the
// half-finished deploy the script's own header calls worse than none.
//
// `lineOf` resolves only to an executable line, never a comment. This script's house style is
// dense narrative comments that routinely repeat command fragments in prose — line 54's own
// comment, "`fetch` then `reset --hard`, not `pull`…", says the words `reset --hard` a full five
// lines before the real `git … reset --hard` on line 59. A needle search that does not skip `#`
// lines would resolve to whichever comment mentions the words first, not the command that runs
// them — verifying comment placement, not execution order. Needles are also written as close to
// the real command text as practical (e.g. `git -C "$APP_DIR" reset --hard`, not the bare fragment
// `reset --hard`), belt and braces with the comment skip: either mechanism alone should be enough,
// together they make a false pass from an unrelated future comment very unlikely.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve(__dirname, "../../deploy/herald-deploy.sh"), "utf8");
const scriptLines = script.split("\n");

const lineOf = (needle: string): number => {
  const i = scriptLines.findIndex((l) => {
    const trimmed = l.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && l.includes(needle);
  });
  expect(i, `not found in an executable line of herald-deploy.sh: ${needle}`).toBeGreaterThan(-1);
  return i;
};

const GATE_CHECK = 'pnpm deploy:freeze --check --dev "$DEV_DIR" --app "$APP_DIR" "$@"';
const GATE_APPLY = 'pnpm deploy:freeze --apply --dev "$DEV_DIR" --app "$APP_DIR"';
const HARD_RESET = 'git -C "$APP_DIR" reset --hard';
const PNPM_INSTALL = 'pnpm install --frozen-lockfile --silent';
const DB_MIGRATE = 'cd "$APP_DIR" && pnpm db:migrate';

describe("herald-deploy.sh freezes configuration", () => {
  it("no longer symlinks anything into the deploy checkout", () => {
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("link_ignored_config");
  });

  it("gates before it moves the code", () => {
    expect(lineOf(GATE_CHECK)).toBeLessThan(lineOf(HARD_RESET));
  });

  it("applies after dependencies are installed", () => {
    expect(lineOf(GATE_APPLY)).toBeGreaterThan(lineOf(PNPM_INSTALL));
  });

  it("applies before the schema migration, which runs the frozen code", () => {
    expect(lineOf(GATE_APPLY)).toBeLessThan(lineOf(DB_MIGRATE));
  });

  it("passes its own arguments through to the gate so --yes reaches it", () => {
    expect(script).toContain(GATE_CHECK);
  });

  it("resolves needles to real code, never to a comment that merely mentions the same words", () => {
    // The proof this matters, using a collision already live in the file: line 54's own comment
    // contains the bare phrase `reset --hard` and sits before the real command on line 59. Against
    // a comment-blind lineOf this assertion fails, because it would resolve to the comment line,
    // which trimmed starts with "#".
    for (const needle of [GATE_CHECK, GATE_APPLY, HARD_RESET, PNPM_INSTALL, DB_MIGRATE, "reset --hard"]) {
      const line = scriptLines[lineOf(needle)];
      expect(line.trim().startsWith("#"), `${JSON.stringify(needle)} resolved to a comment: ${JSON.stringify(line)}`).toBe(false);
    }
  });
});
