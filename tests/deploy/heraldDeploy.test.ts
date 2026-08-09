// tests/deploy/heraldDeploy.test.ts
//
// The script is read as text, the convention the rest of tests/deploy/ uses for shell and unit
// files. Two properties matter and neither is visible from the CLI's own tests: that the symlink is
// gone, and that the gate runs before the code moves. Gating after `git reset --hard origin/main`
// would refuse a deploy having already left the checkout on a commit nobody chose to deploy — the
// half-finished deploy the script's own header calls worse than none.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve(__dirname, "../../deploy/herald-deploy.sh"), "utf8");
const lineOf = (needle: string): number => {
  const i = script.split("\n").findIndex((l) => l.includes(needle));
  expect(i, `not found in herald-deploy.sh: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("herald-deploy.sh freezes configuration", () => {
  it("no longer symlinks anything into the deploy checkout", () => {
    expect(script).not.toContain("ln -sfn");
    expect(script).not.toContain("link_ignored_config");
  });

  it("gates before it moves the code", () => {
    expect(lineOf("deploy:freeze --check")).toBeLessThan(lineOf("reset --hard"));
  });

  it("applies after dependencies are installed", () => {
    expect(lineOf("deploy:freeze --apply")).toBeGreaterThan(lineOf("pnpm install"));
  });

  it("applies before the schema migration, which runs the frozen code", () => {
    expect(lineOf("deploy:freeze --apply")).toBeLessThan(lineOf("pnpm db:migrate"));
  });

  it("passes its own arguments through to the gate so --yes reaches it", () => {
    expect(script).toContain('deploy:freeze --check --dev "$DEV_DIR" --app "$APP_DIR" "$@"');
  });
});
