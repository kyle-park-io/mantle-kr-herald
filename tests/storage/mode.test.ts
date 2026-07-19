import { describe, it, expect } from "vitest";
import { parseStorageMode, localSkipMessage } from "../../src/storage/mode";

describe("parseStorageMode", () => {
  it("accepts the two valid modes", () => {
    expect(parseStorageMode("local")).toBe("local");
    expect(parseStorageMode("cloud")).toBe("cloud");
  });

  it("trims surrounding whitespace", () => {
    expect(parseStorageMode("  cloud  ")).toBe("cloud");
  });

  it("never guesses when unset — it throws and names both valid values", () => {
    expect(() => parseStorageMode(undefined)).toThrow(/HERALD_STORAGE_MODE/);
    expect(() => parseStorageMode(undefined)).toThrow(/local/);
    expect(() => parseStorageMode(undefined)).toThrow(/cloud/);
    expect(() => parseStorageMode("")).toThrow(/HERALD_STORAGE_MODE/);
  });

  it("rejects an unknown value and echoes it back", () => {
    expect(() => parseStorageMode("gcs")).toThrow(/gcs/);
  });
});

describe("localSkipMessage", () => {
  it("names the command and how to enable it", () => {
    const msg = localSkipMessage("drive:publish");
    expect(msg).toContain("drive:publish");
    expect(msg).toContain("local mode");
    expect(msg).toContain("HERALD_STORAGE_MODE=cloud");
  });
});
