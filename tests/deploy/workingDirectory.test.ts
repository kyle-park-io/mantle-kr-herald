// tests/deploy/workingDirectory.test.ts
//
// Both scheduled units run `pnpm <script>` out of a `WorkingDirectory`, which means they run
// whatever is checked out there at the moment the timer fires — not the code that was reviewed and
// merged. Until 2026-08-07 that directory was the development checkout, so every feature branch was
// live in production the instant it was checked out.
//
// It cost a real outage that day. A branch added `translations.published_text`; the 18:41 fire of
// herald-x-reconcile.service ran that branch's query against a production database with no such
// column, exited non-zero, and fired the `OnFailure=` Telegram hook. Nothing about that branch was
// wrong — it simply was not merged, and had no business being in production at all.
//
// The fix is a separate deploy checkout under %h/.herald/, updated only from merged `main`. This
// file is what stops the units drifting back: prose in a runbook about which directory to use is
// exactly the documentation that rots the first time someone edits a unit file.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");

// Every scheduled unit, not a sample of them: this list is what makes the checks below apply to a
// unit added later, and a unit missing from it is exactly the one that quietly runs from wherever
// somebody left it.
const UNITS = [
  "deploy/herald-watch.service",
  "deploy/herald-x-reconcile.service",
  "deploy/herald-convert.service",
] as const;

/** The unit's `WorkingDirectory=` value. */
function workingDirectory(unitPath: string): string | undefined {
  const unit = readFileSync(resolve(repoRoot, unitPath), "utf8");
  return /^WorkingDirectory=(.+)$/m.exec(unit)?.[1]?.trim();
}

describe("scheduled units run from the deploy checkout, never a development one", () => {
  for (const unitPath of UNITS) {
    it(`${unitPath} points at the deploy checkout`, () => {
      // `%h/.herald/app` and not an absolute path: %h is the one thing systemd expands for a user
      // unit, and it keeps the whole runtime tree (prod.env, output/, the app itself) under one
      // directory. HERALD_OUTPUT_DIR already lives at %h/.herald/output for the same reason.
      expect(workingDirectory(unitPath)).toBe("%h/.herald/app");
    });

    it(`${unitPath} does not run from this checkout`, () => {
      // The invariant the incident was actually about, asserted directly rather than inferred from
      // the string above: whatever directory the units name, it must not be the tree someone edits.
      // This is the check that still means something if the deploy path is ever moved.
      expect(workingDirectory(unitPath)).not.toBe(repoRoot);
    });

    it(`${unitPath} names the same directory herald-deploy.sh updates`, () => {
      // Two files, one decision. The units say where production runs from; the deploy script says
      // where it installs to. If they drift, `herald-deploy.sh` faithfully updates a directory
      // nothing runs, and the timers keep firing whatever was last left in the directory they do
      // run — a deploy that reports success and changes nothing. Same reasoning as
      // watchCutoff.test.ts, which pins the collect floor and the translate floor equal.
      const script = readFileSync(resolve(repoRoot, "deploy/herald-deploy.sh"), "utf8");
      const appDir = /^APP_DIR="([^"]+)"$/m.exec(script)?.[1];
      // The script runs in a shell, where `%h` means nothing — it spells the same location as
      // "$HOME/.herald/app". Compared after substituting, so the two spellings cannot be read as a
      // mismatch, and a real divergence still fails.
      expect(appDir).toBe('$HOME/.herald/app');
      expect(workingDirectory(unitPath)?.replace("%h", "$HOME")).toBe(appDir);
    });
  }

  // The failure hook runs a script by absolute path rather than through a WorkingDirectory, so it
  // needs its own check — and it is the one that matters most. A scheduled unit running unmerged
  // code fails loudly (that is how the 2026-08-07 incident was noticed at all); a *failure hook*
  // running unmerged code fails silently, because the only thing it would have told anyone is that
  // something else failed. Merging an edit to that script has already broken the live alert once
  // for ~6 minutes (PR #124), which is exactly this hazard in its earlier form.
  it("deploy/herald-notify-failure@.service runs the script from the deploy checkout", () => {
    const unit = readFileSync(resolve(repoRoot, "deploy/herald-notify-failure@.service"), "utf8");
    const execStart = /^ExecStart=(.+)$/m.exec(unit)?.[1]?.trim();
    expect(execStart).toBe("%h/.herald/app/deploy/herald-notify-failure.sh %i");
    expect(execStart?.startsWith(repoRoot)).toBe(false);
  });

  it("herald-notify-failure.sh reads .env from its own checkout, not a hardcoded one", () => {
    // Once the script is invoked out of the deploy checkout, a hardcoded development path would
    // send it back to read a different tree's .env. That was survivable by accident while the
    // deploy checkout's .env was a symlink into the development tree; since 2026-08-09 it is a
    // deploy-time copy, so the two files genuinely differ between deploys.
    const script = readFileSync(resolve(repoRoot, "deploy/herald-notify-failure.sh"), "utf8");
    expect(script).not.toContain(`REPO_DIR="${repoRoot}"`);
    expect(script).toMatch(/REPO_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]}"\)\/\.\." && pwd\)"/);
  });
});
