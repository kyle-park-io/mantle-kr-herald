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
});
