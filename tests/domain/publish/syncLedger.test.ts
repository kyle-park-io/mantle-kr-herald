import { describe, it, expect } from "vitest";
import { entryKey, contentHash, migrateLegacyKeys, isStale, type SyncEntry } from "../../../src/domain/publish/syncLedger";

describe("entryKey", () => {
  it("joins itemId, status and target", () => {
    expect(entryKey({ itemId: "x:1934", status: "approved", target: "google" })).toBe("x:1934:approved:google");
  });
});

describe("contentHash", () => {
  it("is stable and prefixed", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when the content changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("migrateLegacyKeys", () => {
  it("splits from the right, because itemId itself contains a colon", () => {
    const [entry] = migrateLegacyKeys(["x:1934567:approved:google"]);
    expect(entry.itemId).toBe("x:1934567");
    expect(entry.status).toBe("approved");
    expect(entry.target).toBe("google");
    expect(entry.stage).toBe("translation");
  });

  it("leaves the unknowable fields undefined rather than inventing them", () => {
    const [entry] = migrateLegacyKeys(["lark:om_abc:translated:lark"]);
    expect(entry.remoteId).toBeUndefined();
    expect(entry.contentHash).toBeUndefined();
    expect(entry.uploadedAt).toBeUndefined();
  });

  it("skips malformed keys instead of throwing", () => {
    expect(migrateLegacyKeys(["nonsense"])).toEqual([]);
  });
});

describe("isStale", () => {
  const base: SyncEntry = { itemId: "x:1", stage: "translation", status: "approved", target: "google" };

  it("is true when the content changed since upload", () => {
    expect(isStale({ ...base, contentHash: contentHash("old") }, contentHash("new"))).toBe(true);
  });

  it("is false when the content is unchanged", () => {
    expect(isStale({ ...base, contentHash: contentHash("same") }, contentHash("same"))).toBe(false);
  });

  it("is false for a migrated entry — an unknown hash is not evidence of staleness", () => {
    expect(isStale(base, contentHash("anything"))).toBe(false);
  });
});
