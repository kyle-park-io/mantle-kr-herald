// tests/paths.outputRoot.test.ts
import { describe, it, expect, vi } from "vitest";

// The brief's own draft cache-busts with a `?query=${Date.now()}` suffix on the specifier. Under
// this repo's vitest/Vite setup that trips `vite:dynamic-import-vars` ("A file extension must be
// included in the static part of the import") and silently falls back to the already-cached
// module instance — the "honours HERALD_OUTPUT_DIR" assertion below then passes for the wrong
// reason (or fails to observe the override at all), which is exactly the "asserting nothing"
// trap the brief warns against. `vi.resetModules()` + a plain re-import is the form
// `tests/paths.test.ts` already relies on to force a fresh module-level evaluation, so this file
// follows that instead.
describe("OUTPUT_DIR", () => {
  it("honours HERALD_OUTPUT_DIR and resolves it to an absolute path", async () => {
    const prev = process.env.HERALD_OUTPUT_DIR;
    process.env.HERALD_OUTPUT_DIR = "some/relative/root";
    try {
      vi.resetModules();
      const mod = await import("../src/paths");
      expect(mod.OUTPUT_DIR.startsWith("/")).toBe(true);
      expect(mod.OUTPUT_DIR.endsWith("some/relative/root")).toBe(true);
      expect(mod.paths.translationsWorksheets.startsWith(mod.OUTPUT_DIR)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HERALD_OUTPUT_DIR;
      else process.env.HERALD_OUTPUT_DIR = prev;
      vi.resetModules();
    }
  });

  it("falls back to the repo's own output/ when unset", async () => {
    const prev = process.env.HERALD_OUTPUT_DIR;
    delete process.env.HERALD_OUTPUT_DIR;
    try {
      vi.resetModules();
      const mod = await import("../src/paths");
      expect(mod.OUTPUT_DIR).toBe(`${mod.REPO_ROOT}/output`);
    } finally {
      if (prev !== undefined) process.env.HERALD_OUTPUT_DIR = prev;
      vi.resetModules();
    }
  });
});
