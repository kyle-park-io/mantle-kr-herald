import { describe, it, expect } from "vitest";
import { assembleConfigBundle, parseConfigBundle } from "../../../src/domain/config/bundle";

describe("config bundle", () => {
  it("round-trips files through assemble → parse", () => {
    const files = [
      { path: "translation/glossary.json", content: "[]" },
      { path: "conversion/announcement.md", content: "# 공지" },
    ];
    const json = assembleConfigBundle(files, () => "2026-07-28T00:00:00.000Z");
    expect(parseConfigBundle(json)).toEqual(files);
  });

  it("writes version + pushedAt", () => {
    const json = assembleConfigBundle([], () => "2026-07-28T00:00:00.000Z");
    const obj = JSON.parse(json);
    expect(obj.version).toBe(1);
    expect(obj.pushedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(obj.files).toEqual({});
  });

  it("rejects a non-JSON download", () => {
    expect(() => parseConfigBundle("not json")).toThrow(/not a valid config bundle/);
  });

  it("rejects a bundle missing the files map", () => {
    expect(() => parseConfigBundle(JSON.stringify({ version: 1, pushedAt: "t" }))).toThrow(/not a valid config bundle/);
  });
});
