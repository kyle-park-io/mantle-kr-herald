import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runStage } from "../../../src/adapters/agent/runStage";
import { REPO_ROOT } from "../../../src/paths";

// `pnpm --version` prints the pinned version, not necessarily the one this happened to be invoked
// with — deriving it from `package.json`'s own `packageManager` field (rather than hardcoding it,
// matching how `tests/docs/koDocs.test.ts` reads the same file) means this test never goes stale
// just because pnpm gets bumped.
async function expectedPnpmVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8")) as { packageManager: string };
  return pkg.packageManager.split("@")[1];
}

describe("runStage", () => {
  it("reports failure with the stage name when the script exits non-zero", async () => {
    const result = await runStage("this-script-does-not-exist", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.stage).toBe("this-script-does-not-exist");
  });

  it("reports success with the real stdout when the script exits zero", async () => {
    // "--version" isn't a package script, but `runStage` builds `pnpm <script> <args...>`
    // unconditionally — this exercises the exact same code path with a command that is guaranteed
    // to succeed and print real output, without touching the database, the network, or any other
    // pipeline stage.
    const result = await runStage("--version", []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout.trim()).toBe(await expectedPnpmVersion());
  });

  it("resolves the repo root as cwd regardless of the caller's own working directory", async () => {
    // "--version" is a global pnpm flag that works from anywhere, so it can't tell a correct cwd
    // apart from a missing one — it would pass even if `runStage` silently inherited the caller's
    // cwd instead of anchoring to the repo root. Bare `pnpm run` (no script name) does depend on
    // finding this repo's package.json: it exits 0 and lists the available scripts when it can,
    // and exits 1 with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND when run from a directory with none —
    // confirmed directly: `cd /tmp && pnpm run` exits 1, `pnpm run` from the repo root exits 0.
    const originalCwd = process.cwd();
    process.chdir("/tmp");
    try {
      const result = await runStage("run", []);
      expect(result.ok).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("flattens a multi-line stderr into one line", async () => {
    // A stack trace is the normal shape of a failing stage's stderr, and this detail does not stay
    // a string: `watch.ts` prints it as one `console.log`, journald splits it into one entry per
    // line, and `deploy/herald-notify-failure.sh` reads back only the last five entries. Five
    // lines of stack trace are enough to push the `watch: FAILED — <stage>:` prefix — the only
    // part that says what broke — out of the alert entirely.
    const result = await runStage("exec", [
      "node",
      "-e",
      "console.error('boom-marker\\n    at first (/a.ts:1:1)\\n    at second (/b.ts:2:2)\\n    at third (/c.ts:3:3)\\n    at fourth (/d.ts:4:4)\\n    at fifth (/e.ts:5:5)'); process.exit(2)",
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).not.toContain("\n");
      expect(result.detail).toContain("boom-marker");
      // Flattened, not merely stripped at the ends: the frames are still there, separated by
      // single spaces.
      expect(result.detail).toContain("boom-marker at first (/a.ts:1:1)");
    }
  });

  it("truncates a very long stderr rather than passing all of it on", async () => {
    // The other half of the same budget: the hook keeps only the last 500 characters of what it
    // reads back, so a single enormous line costs the alert its prefix just as surely as five
    // short ones do.
    const result = await runStage("exec", ["node", "-e", "console.error('E'.repeat(5000)); process.exit(2)"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail.length).toBeLessThanOrEqual(301); // 300 + the ellipsis
      expect(result.detail.endsWith("…")).toBe(true);
    }
  });

  it("carries the failing script's stderr into the detail", async () => {
    // `pnpm exec <cmd> <args...>` runs an arbitrary command through pnpm without needing a real
    // package script, the database, or the network — `pnpm this-script-does-not-exist` above can't
    // stand in for this: pnpm prints its own "script not found" message to STDOUT, not stderr, so
    // that test can only pin `ok`/`stage`, never detail content.
    const result = await runStage("exec", ["node", "-e", "console.error('boom-marker'); process.exit(2)"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("boom-marker");
  });
});
