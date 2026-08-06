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

  it("does not count a `posted` item at all — it is terminal for the Drive path", () => {
    // Final review, Important 2. `x:2080608995371597892` is one of the five items that retire on the
    // first production run and is exactly this shape: approved, published to approved/, then retired
    // to `posted` by reconcile. Its ledger row's status ("approved") no longer equals the item's
    // status ("posted"), so the row-vs-status comparison flagged it as needing republish — every
    // run, forever, since nothing moves it back. The dashboard lit ⚠ and TranslationDetail told the
    // reviewer "발행을 다시 눌러 갱신하세요"; following that instruction re-rendered the item as a
    // review doc, uploaded it to review/, and deleted the approved doc holding the copy that was
    // actually published. The content hash matches here, so the row's *status* alone is what used to
    // flip it — which is why counting it as synced-by-hash would not have been enough either.
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("published copy") },
    ];
    expect(syncSummary({ translations: [t("x:1", "posted", "published copy")], entries, render })).toEqual({
      synced: 0, needsRepublish: 0, unpublished: 0,
    });
  });

  it("does not count a `posted` item that was never published to Drive either", () => {
    // The other half: retired without ever reaching Drive (reconcile can retire a `translated` item).
    // Counting it as `unpublished` would raise the same standing ⚠ about work that is now impossible
    // — PublishTranslations skips it, the 발행 buttons are disabled, and the route answers 409.
    expect(syncSummary({ translations: [t("x:1", "posted", "hi")], entries: [], render })).toEqual({
      synced: 0, needsRepublish: 0, unpublished: 0,
    });
  });

  it("still reports a genuinely stale APPROVED item beside a posted one", () => {
    // The exclusion is scoped to `posted`, not to "anything with an odd-looking row". Pressing 발행
    // really is the fix for a stale approved item, so dropping that from the report would trade one
    // silent wrong answer for another.
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("old") },
      { itemId: "x:2", stage: "translation", status: "approved", target: "google", contentHash: contentHash("whatever") },
    ];
    expect(
      syncSummary({ translations: [t("x:1", "approved", "edited since"), t("x:2", "posted", "gone out")], entries, render }),
    ).toEqual({ synced: 0, needsRepublish: 1, unpublished: 0 });
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
