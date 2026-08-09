// tests/deploy/unitToolPaths.test.ts
//
// A systemd user unit has no useful PATH of its own, so these units name node and pnpm outright.
// Until 2026-08-09 they named them by their nvm version directory
// (`/home/kyle/.nvm/versions/node/v24.14.0/bin`), and nvm deletes that directory on upgrade.
//
// That is a uniquely bad failure to write into a scheduler. The unit does not degrade — it never
// starts: systemd reports 203/EXEC before a single line of the pipeline runs, on every fire, and
// the only outward sign is the OnFailure= Telegram alert firing on a schedule. A rebuild of this
// machine on 2026-08-09 came back with v24.19.0 and left all three units naming v24.14.0, which is
// how the trap was found — before installation, by luck rather than by a check.
//
// So the units now go through `%h/.herald/bin`, a directory of symlinks the operator re-points
// after a node upgrade (the unit files themselves never change). This file is what stops the next
// edit quietly reintroducing a versioned path.
//
// The unit list is derived from deploy/ rather than hardcoded: a scheduled unit added later is
// exactly the one that would be written by copying an existing file, versioned path and all.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const deployDir = resolve(repoRoot, "deploy");

const unitFiles = readdirSync(deployDir)
  .filter((f) => f.endsWith(".service"))
  .sort();

/** The stable indirection every unit must reach node and pnpm through. */
const TOOL_BIN = "%h/.herald/bin";

describe("scheduled units reach node and pnpm through a stable path", () => {
  it("finds the units to check (a glob that matches nothing would pass every test below)", () => {
    expect(unitFiles.length).toBeGreaterThan(0);
    expect(unitFiles).toContain("herald-watch.service");
  });

  for (const file of unitFiles) {
    const unit = readFileSync(join(deployDir, file), "utf8");
    // Directives only. The comments deliberately quote the old versioned path to explain the
    // incident, and a test that failed on those would push the explanation out of the file.
    const directives = unit
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

    it(`${file} names no nvm version directory`, () => {
      const offenders = directives.filter((l) => l.includes("/.nvm/versions/node/"));
      expect(offenders, `nvm paths disappear on upgrade — use ${TOOL_BIN} instead`).toEqual([]);
    });

    const execStart = directives.find((l) => l.startsWith("ExecStart="));

    it(`${file} invokes pnpm — if at all — through ${TOOL_BIN}`, () => {
      if (execStart === undefined || !execStart.includes("pnpm")) return; // e.g. the notify-failure template
      expect(execStart).toContain(`${TOOL_BIN}/pnpm`);
    });

    it(`${file} puts ${TOOL_BIN} on PATH — if it sets one — ahead of everything else`, () => {
      const path = directives.find((l) => l.startsWith("Environment=PATH="));
      if (path === undefined) return;
      const first = path.slice("Environment=PATH=".length).split(":")[0];
      // First, not merely present: pnpm's own file starts `#!/usr/bin/env node`, so whichever node
      // this PATH resolves first is the one that runs the pipeline.
      expect(first).toBe(TOOL_BIN);
    });
  }
});
