import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OUTPUT_DIR, REPO_ROOT, paths } from "../src/paths";

const original = process.cwd();
afterEach(() => process.chdir(original));

describe("paths", () => {
  it("anchors to the repo root, not the process cwd", () => {
    const before = OUTPUT_DIR;
    process.chdir(tmpdir());
    expect(OUTPUT_DIR).toBe(before);
    expect(OUTPUT_DIR).toBe(join(REPO_ROOT, "output"));
  });

  it("exposes absolute paths for every store", () => {
    for (const value of Object.values(paths)) {
      expect(isAbsolute(value)).toBe(true);
    }
  });

  it("places stores under their stage directory", () => {
    expect(paths.xItems).toBe(join(OUTPUT_DIR, "x", "items.json"));
    expect(paths.translationsPending).toBe(join(OUTPUT_DIR, "translations", "pending.json"));
    expect(paths.formattedWorksheets).toBe(join(OUTPUT_DIR, "formatted", "worksheets"));
    expect(paths.archiveDir).toBe(join(OUTPUT_DIR, "archive"));
  });

  it("points the steering config dirs at the repo root", () => {
    expect(paths.translationConfigDir).toBe(join(REPO_ROOT, "translation"));
    expect(paths.conversionConfigDir).toBe(join(REPO_ROOT, "conversion"));
  });
});
