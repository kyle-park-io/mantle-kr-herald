import { describe, it, expect } from "vitest";
import { syncSummary, formatSyncSummary } from "../../src/status/sync";
import { contentHash, type SyncEntry } from "../../src/domain/publish/syncLedger";

const render = (t: { itemId: string; text: string }) => t.text;
const t = (itemId: string, status: string, text: string) => ({ itemId, status, text });

describe("syncSummary", () => {
  it("counts a translation with no ledger row as unpublished", () => {
    const s = syncSummary({ translations: [t("x:1", "approved", "hi")], entries: [], render });
    expect(s).toEqual({ synced: 0, needsRepublish: 0, unpublished: 1 });
  });

  it("counts a matching ledger row at the current status as synced", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("hi") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "hi")], entries, render })).toEqual({
      synced: 1, needsRepublish: 0, unpublished: 0,
    });
  });

  it("counts an edited-since-upload translation as needing republish", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("old") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "new")], entries, render })).toEqual({
      synced: 0, needsRepublish: 1, unpublished: 0,
    });
  });

  it("counts a published-then-approved translation (rows at the old status) as needing republish", () => {
    // Published while still under review, then approved: the review docs are now the wrong status.
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "translated", target: "google", contentHash: contentHash("review") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "final")], entries, render })).toEqual({
      synced: 0, needsRepublish: 1, unpublished: 0,
    });
  });

  it("does not call a migrated row (no hash) stale", () => {
    const entries: SyncEntry[] = [{ itemId: "x:1", stage: "translation", status: "approved", target: "google" }];
    const s = syncSummary({ translations: [t("x:1", "approved", "anything")], entries, render });
    expect(s).toEqual({ synced: 1, needsRepublish: 0, unpublished: 0 });
  });

  it("counts a translation matching on multiple targets as one synced", () => {
    const current = contentHash("hello");
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: current },
      { itemId: "x:1", stage: "translation", status: "approved", target: "lark", contentHash: current },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "hello")], entries, render })).toEqual({
      synced: 1, needsRepublish: 0, unpublished: 0,
    });
  });

  it("needs republish once (not per row) when every target is outdated", () => {
    const old = contentHash("old");
    const entries: SyncEntry[] = [
      { itemId: "x:2", stage: "translation", status: "approved", target: "google", contentHash: old },
      { itemId: "x:2", stage: "translation", status: "approved", target: "lark", contentHash: old },
    ];
    expect(syncSummary({ translations: [t("x:2", "approved", "new")], entries, render })).toEqual({
      synced: 0, needsRepublish: 1, unpublished: 0,
    });
  });

  it("needs republish if at least one target is outdated", () => {
    const current = contentHash("current");
    const old = contentHash("old");
    const entries: SyncEntry[] = [
      { itemId: "x:3", stage: "translation", status: "approved", target: "google", contentHash: current },
      { itemId: "x:3", stage: "translation", status: "approved", target: "lark", contentHash: old },
    ];
    expect(syncSummary({ translations: [t("x:3", "approved", "current")], entries, render })).toEqual({
      synced: 0, needsRepublish: 1, unpublished: 0,
    });
  });
});

describe("formatSyncSummary", () => {
  it("stays quiet when everything is synced", () => {
    expect(formatSyncSummary({ synced: 3, needsRepublish: 0, unpublished: 0 })).toContain("3 synced");
    expect(formatSyncSummary({ synced: 3, needsRepublish: 0, unpublished: 0 })).not.toContain("⚠");
  });

  it("warns when work needs republish or is unpublished", () => {
    const out = formatSyncSummary({ synced: 1, needsRepublish: 1, unpublished: 2 });
    expect(out).toContain("⚠");
    expect(out).toContain("2 unpublished");
    expect(out).toContain("1 need republish");
  });

  it("warns for unpublished work in any mode (no local-mode special case)", () => {
    // local mode publishes to output/publish/local/, so unpublished work is a real backlog there
    // exactly as it is on Drive. The old special case hid it.
    const out = formatSyncSummary({ synced: 1, needsRepublish: 0, unpublished: 2 });
    expect(out).toContain("⚠");
    expect(out).not.toContain("local mode");
    expect(out).not.toContain("publishing disabled");
  });
});
