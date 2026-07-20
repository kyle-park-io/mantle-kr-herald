import { describe, it, expect } from "vitest";
import { syncSummary, formatSyncSummary } from "../../src/status/sync";
import { contentHash, type SyncEntry } from "../../src/domain/publish/syncLedger";

const render = (t: { itemId: string; text: string }) => t.text;
const t = (itemId: string, status: string, text: string) => ({ itemId, status, text });

describe("syncSummary", () => {
  it("counts an approved translation with no ledger row as unsynced", () => {
    const s = syncSummary({ translations: [t("x:1", "approved", "hi")], entries: [], render });
    expect(s).toEqual({ published: 0, unsynced: 1, stale: 0 });
  });

  it("counts a matching ledger row as published and not stale", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("hi") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "hi")], entries, render })).toEqual({
      published: 1, unsynced: 0, stale: 0,
    });
  });

  it("counts an edited-since-upload translation as stale", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("old") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "new")], entries, render })).toEqual({
      published: 1, unsynced: 0, stale: 1,
    });
  });

  it("does not call a migrated row stale", () => {
    const entries: SyncEntry[] = [{ itemId: "x:1", stage: "translation", status: "approved", target: "google" }];
    expect(syncSummary({ translations: [t("x:1", "approved", "anything")], entries, render }).stale).toBe(0);
  });

  it("counts a translation with matching rows on multiple targets as one published", () => {
    const current = contentHash("hello");
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: current },
      { itemId: "x:1", stage: "translation", status: "approved", target: "lark", contentHash: current },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "hello")], entries, render })).toEqual({
      published: 1,
      unsynced: 0,
      stale: 0,
    });
  });

  it("counts a translation as stale if any row is outdated, not once per outdated row", () => {
    const old = contentHash("old");
    const entries: SyncEntry[] = [
      { itemId: "x:2", stage: "translation", status: "approved", target: "google", contentHash: old },
      { itemId: "x:2", stage: "translation", status: "approved", target: "lark", contentHash: old },
    ];
    expect(syncSummary({ translations: [t("x:2", "approved", "new")], entries, render })).toEqual({
      published: 1,
      unsynced: 0,
      stale: 1,
    });
  });

  it("counts a translation as stale if at least one row is outdated", () => {
    const current = contentHash("current");
    const old = contentHash("old");
    const entries: SyncEntry[] = [
      { itemId: "x:3", stage: "translation", status: "approved", target: "google", contentHash: current },
      { itemId: "x:3", stage: "translation", status: "approved", target: "lark", contentHash: old },
    ];
    expect(syncSummary({ translations: [t("x:3", "approved", "current")], entries, render })).toEqual({
      published: 1,
      unsynced: 0,
      stale: 1,
    });
  });
});

describe("formatSyncSummary", () => {
  it("stays quiet when everything is synced", () => {
    expect(formatSyncSummary({ published: 3, unsynced: 0, stale: 0 })).toContain("3 published");
    expect(formatSyncSummary({ published: 3, unsynced: 0, stale: 0 })).not.toContain("⚠");
  });

  it("warns when work is unsynced or stale", () => {
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 1 });
    expect(out).toContain("⚠");
    expect(out).toContain("2 unsynced");
    expect(out).toContain("1 stale");
  });

  it("omits the warning marker and labels the line in local mode, even with unsynced work", () => {
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 0 }, "local");
    expect(out).not.toContain("⚠");
    expect(out).toContain("local mode");
    expect(out).toContain("2 unsynced");
  });

  it("keeps the warning marker in cloud mode when work is unsynced", () => {
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 0 }, "cloud");
    expect(out).toContain("⚠");
    expect(out).toContain("2 unsynced");
  });

  it("keeps the warning marker when mode is undefined and work is unsynced", () => {
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 0 }, undefined);
    expect(out).toContain("⚠");
    expect(out).toContain("2 unsynced");
  });

  it("reports identical counts across local, cloud, and undefined modes", () => {
    const counts = { published: 1, unsynced: 2, stale: 1 };
    for (const mode of ["local", "cloud", undefined] as const) {
      const out = formatSyncSummary(counts, mode);
      expect(out).toContain("1 published");
      expect(out).toContain("2 unsynced");
      expect(out).toContain("1 stale");
    }
  });
});
