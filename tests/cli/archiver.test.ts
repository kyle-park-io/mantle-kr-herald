import { describe, it, expect } from "vitest";
import { sentArchiveTargets } from "../../src/cli/archiver";

describe("sentArchiveTargets", () => {
  it("local mode archives to the local folder only", () => {
    expect(sentArchiveTargets("local", { google: true, lark: true })).toEqual(["local"]);
  });
  it("cloud mode archives to whichever drives have a sent folder configured", () => {
    expect(sentArchiveTargets("cloud", { google: true, lark: true })).toEqual(["google", "lark"]);
    expect(sentArchiveTargets("cloud", { google: true, lark: false })).toEqual(["google"]);
    expect(sentArchiveTargets("cloud", { google: false, lark: false })).toEqual([]);
  });
});
