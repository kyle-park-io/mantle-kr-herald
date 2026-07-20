import { describe, it, expect } from "vitest";
import { parseStorageMode, tryParseStorageMode, localSkipMessage, isLocalMode, assertCloudMode } from "../../src/storage/mode";

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

describe("tryParseStorageMode", () => {
  it("returns the mode for valid values", () => {
    expect(tryParseStorageMode("local")).toBe("local");
    expect(tryParseStorageMode("cloud")).toBe("cloud");
  });

  it("returns undefined instead of throwing when unset", () => {
    expect(tryParseStorageMode(undefined)).toBeUndefined();
    expect(tryParseStorageMode("")).toBeUndefined();
  });

  it("returns undefined instead of throwing when invalid", () => {
    expect(tryParseStorageMode("bogus")).toBeUndefined();
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

describe("isLocalMode", () => {
  it("is true only for local", () => {
    expect(isLocalMode("local")).toBe(true);
    expect(isLocalMode("cloud")).toBe(false);
  });
});

describe("assertCloudMode", () => {
  it("does not throw in cloud mode", () => {
    expect(() => assertCloudMode("cloud", "publishing")).not.toThrow();
  });

  it("throws in local mode, naming the action and how to enable it", () => {
    expect(() => assertCloudMode("local", "publishing")).toThrow(
      "local mode — publishing is disabled (set HERALD_STORAGE_MODE=cloud to enable)",
    );
  });
});
