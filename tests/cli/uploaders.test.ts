import { describe, it, expect } from "vitest";
import { ALL_TARGETS, TARGETS_USAGE, defaultTarget, resolveTargets } from "../../src/cli/uploaders";

describe("defaultTarget", () => {
  it("defaults to local in local mode", () => {
    expect(defaultTarget("local")).toBe("local");
  });

  it("defaults to google in cloud mode, unchanged from before", () => {
    expect(defaultTarget("cloud")).toBe("google");
  });
});

describe("resolveTargets", () => {
  it("uses the mode's default when no flag was given", () => {
    expect(resolveTargets(undefined, "local")).toEqual(["local"]);
    expect(resolveTargets(undefined, "cloud")).toEqual(["google"]);
  });

  it("parses a comma-separated list", () => {
    expect(resolveTargets("google,local", "cloud")).toEqual(["google", "local"]);
  });

  it("keeps both as an alias for google,lark", () => {
    expect(resolveTargets("both", "cloud")).toEqual(["google", "lark"]);
  });

  it("de-duplicates when both and an explicit target overlap", () => {
    expect(resolveTargets("both,google", "cloud")).toEqual(["google", "lark"]);
  });

  it("allows local alongside cloud targets in cloud mode", () => {
    expect(resolveTargets("both,local", "cloud")).toEqual(["google", "lark", "local"]);
  });

  it("rejects a cloud target in local mode instead of silently skipping", () => {
    expect(() => resolveTargets("google", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
    expect(() => resolveTargets("lark", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
    expect(() => resolveTargets("both", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
  });

  it("rejects an unknown target and names the valid ones", () => {
    expect(() => resolveTargets("dropbox", "cloud")).toThrow(/dropbox/);
    expect(() => resolveTargets("dropbox", "cloud")).toThrow(/google\|lark\|local/);
  });

  it("derives the usage string from ALL_TARGETS rather than hardcoding it", () => {
    expect(TARGETS_USAGE).toBe(ALL_TARGETS.join("|"));
  });
});
