import { describe, it, expect, vi } from "vitest";
import { SaveTranslation } from "../../src/app/SaveTranslation";
import { SaveConversion } from "../../src/app/SaveConversion";
import { SaveRendering } from "../../src/app/SaveRendering";
import { ApproveRendering } from "../../src/app/ApproveRendering";
import { SaveOutletOverride } from "../../src/app/SaveOutletOverride";
import { overrideKey, type OutletOverride } from "../../src/domain/outlet/override";
import type { LineageStore, LineageSummary } from "../../src/ports/LineageStore";
import type { LineageEntry } from "../../src/domain/lineage/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import { ALL_TYPES, type ConversionType } from "../../src/domain/conversion/models";

function fakeLineage() {
  const appended: LineageEntry[] = [];
  const store: LineageStore = {
    append: async (e) => { appended.push(e); },
    load: async () => [],
    listItems: async (): Promise<LineageSummary[]> => [],
  };
  return { store, appended };
}
const noTranslationStore: TranslationStore = { loadAll: async () => [], upsert: async () => {}, listTranslatedIds: async () => new Set() };
const noFewShot: FewShotStore = { load: async () => [], add: async () => {} };
const fakeFormatting: FormattingStore = { loadAll: async () => [], upsert: async () => {}, listRenderedKeys: async () => new Set() };
const fakeConversionStore: ConversionStore = { loadAll: async () => [], upsert: async () => {}, listConvertedKeys: async () => new Set() };
// Built from ALL_TYPES so a new ConversionType does not have to be hand-added here.
const fakeFewShotByType = Object.fromEntries(ALL_TYPES.map((t) => [t, noFewShot])) as Record<ConversionType, FewShotStore>;

describe("lineage capture", () => {
  it("SaveTranslation appends a translated entry with sourceText", async () => {
    const l = fakeLineage();
    await new SaveTranslation(noTranslationStore, noFewShot, () => "T", l.store).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(l.appended).toEqual([
      { itemId: "x:1", stage: "translated", content: "안녕", status: "translated", sourceText: "hi", at: "T" },
    ]);
  });

  it("SaveRendering appends a rendered entry keyed by type/channel", async () => {
    const l = fakeLineage();
    await new SaveRendering(fakeFormatting, () => "T", l.store).run({
      itemId: "x:1", type: "announcement", channel: "telegram", text: "본문",
    });
    expect(l.appended[0]).toMatchObject({ itemId: "x:1", stage: "rendered", variant: "announcement/telegram", status: "rendered", at: "T" });
  });

  it("SaveConversion appends a converted entry", async () => {
    const l = fakeLineage();
    await new SaveConversion(fakeConversionStore, () => "T", l.store).run({
      itemId: "x:1", type: "announcement", sourceKorean: "원본KO", convertedText: "공지문",
    });
    expect(l.appended).toEqual([
      { itemId: "x:1", stage: "converted", variant: "announcement", content: "공지문", status: "converted", at: "T" },
    ]);
  });

  it("ApproveRendering appends a rendered entry with status \"approved\"", async () => {
    const l = fakeLineage();
    const store: FormattingStore = {
      loadAll: async () => [
        { itemId: "x:1", type: "announcement", channel: "telegram", text: "본문", refined: true, createdAt: "C", status: "rendered" },
      ],
      upsert: async () => {},
      listRenderedKeys: async () => new Set(),
    };
    await new ApproveRendering(store, fakeConversionStore, fakeFewShotByType, () => "T", l.store).run({ itemId: "x:1", type: "announcement", channel: "telegram" });
    expect(l.appended[0]).toMatchObject({ itemId: "x:1", stage: "rendered", variant: "announcement/telegram", content: "본문", status: "approved", at: "T" });
  });

  it("ApproveRendering does NOT append when the rendering is not found", async () => {
    const l = fakeLineage();
    await new ApproveRendering(fakeFormatting, fakeConversionStore, fakeFewShotByType, () => "T", l.store).run({ itemId: "x:1", type: "announcement", channel: "telegram" });
    expect(l.appended).toHaveLength(0);
  });

  it("a lineage append failure is swallowed — the save still succeeds", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T", throwing).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false, normalizedPhotoMarkers: 0 });
  });

  it("no lineage store injected = no append, unchanged behavior", async () => {
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T").run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false, normalizedPhotoMarkers: 0 });
  });
});

function fakeOverrideStore(seed: OutletOverride[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    upsert: async (o: OutletOverride) => { rows = [...rows.filter((r) => overrideKey(r) !== overrideKey(o)), o]; },
    remove: async (key: string) => { rows = rows.filter((r) => overrideKey(r) !== key); },
    rows: () => rows,
  };
}
const fork = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain" };
const forked = (over: Partial<OutletOverride> = {}): OutletOverride => ({
  ...fork, text: "이 방 전용", status: "rendered", createdAt: "T0", ...over,
});

/**
 * `output/formatted/overrides.json` holds the *only* copy of a forked room's text — `format`
 * regenerates the group text, never the reviewer's per-room edit. These tests are what stands
 * between a click on `그룹 글로 되돌리기` and a text nobody can get back.
 */
describe("lineage capture — outlet forks", () => {
  it("SaveOutletOverride appends a forked entry keyed by type/outletId, with the canonicalised text", async () => {
    const l = fakeLineage();
    await new SaveOutletOverride(fakeOverrideStore(), () => "T", l.store).run({ ...fork, text: "첫 트윗.\n\n---\n\n둘째 트윗." });
    expect(l.appended).toEqual([
      // Canonicalised, because that is what the room will actually send — recording the keystrokes
      // would preserve a text that never existed downstream.
      { itemId: "x:1", stage: "forked", variant: "announcement/tg-blockchain", content: "첫 트윗.\n\n\n둘째 트윗.", status: "rendered", at: "T" },
    ]);
  });

  it("stamps a re-edit with the time of the edit, not the fork's original createdAt", async () => {
    const l = fakeLineage();
    await new SaveOutletOverride(fakeOverrideStore([forked({ text: "v1", createdAt: "T0" })]), () => "T2", l.store).run({ ...fork, text: "v2" });
    expect(l.appended[0]).toMatchObject({ content: "v2", at: "T2" });
  });

  it("appends a forked entry on approve carrying the current fork text", async () => {
    const l = fakeLineage();
    await new SaveOutletOverride(fakeOverrideStore([forked()]), () => "T2", l.store).run({ ...fork, approve: true });
    expect(l.appended).toEqual([
      { itemId: "x:1", stage: "forked", variant: "announcement/tg-blockchain", content: "이 방 전용", status: "approved", at: "T2" },
    ]);
  });

  it("appends a forked entry on 승인 취소", async () => {
    const l = fakeLineage();
    await new SaveOutletOverride(fakeOverrideStore([forked({ status: "approved", approvedAt: "T1" })]), () => "T2", l.store).run({ ...fork, approve: false });
    expect(l.appended[0]).toMatchObject({ status: "rendered", content: "이 방 전용", at: "T2" });
  });

  /**
   * The point of the whole change. Revert used to call `store.remove(key)` having read nothing, so
   * the text was gone before anything could record it.
   */
  it("records the discarded text on revert — the one moment a fork can vanish", async () => {
    const l = fakeLineage();
    const s = fakeOverrideStore([forked({ text: "되돌리면 사라질 글", status: "approved", approvedAt: "T1" })]);
    const res = await new SaveOutletOverride(s, () => "T2", l.store).run({ ...fork, revert: true });
    expect(res).toBeUndefined();
    expect(s.rows()).toEqual([]); // the revert still happened
    expect(l.appended).toEqual([
      // `reverted`, not the record's own `approved`: the content is identical to the previous entry,
      // so the record's status would render as a no-op in `pnpm lineage`.
      { itemId: "x:1", stage: "forked", variant: "announcement/tg-blockchain", content: "되돌리면 사라질 글", status: "reverted", at: "T2" },
    ]);
  });

  it("does not append when reverting a room that was never forked", async () => {
    const l = fakeLineage();
    await new SaveOutletOverride(fakeOverrideStore(), () => "T", l.store).run({ ...fork, revert: true });
    expect(l.appended).toHaveLength(0);
  });

  /**
   * The revert is the one capture site that is NOT best-effort, and this is the assertion that says
   * so. Swallowing here would destroy an unregenerable text on a full disk and report success, with
   * the only trace a `console.warn` on a server console nobody reads. Failing loudly costs the
   * operator a retry; swallowing costs them the text.
   */
  it("a lineage append failure aborts the revert — the fork survives instead of vanishing", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const s = fakeOverrideStore([forked({ text: "지켜져야 할 글" })]);
    await expect(new SaveOutletOverride(s, () => "T", throwing).run({ ...fork, revert: true })).rejects.toThrow(/disk full/);
    expect(s.rows()).toEqual([forked({ text: "지켜져야 할 글" })]); // still there — nothing was lost
  });

  it("an unreadable override store aborts the revert rather than deleting a text it could not copy", async () => {
    const l = fakeLineage();
    let removed: string | undefined;
    const unreadable = {
      loadAll: async (): Promise<OutletOverride[]> => { throw new Error("EIO"); },
      upsert: async () => {},
      remove: async (k: string) => { removed = k; },
    };
    await expect(new SaveOutletOverride(unreadable, () => "T", l.store).run({ ...fork, revert: true })).rejects.toThrow(/EIO/);
    expect(removed).toBeUndefined();
    expect(l.appended).toHaveLength(0);
  });

  /** The other two sites stay best-effort: the override survives them, so a lost append costs only history. */
  it("a throwing lineage store leaves a text save's outcome and the override store unchanged", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const s = fakeOverrideStore();
    const saved = await new SaveOutletOverride(s, () => "T", throwing).run({ ...fork, text: "이 방 전용" });
    expect(saved).toMatchObject({ text: "이 방 전용", status: "rendered", createdAt: "T" });
    expect(s.rows()).toHaveLength(1);
  });

  it("a throwing lineage store leaves an approve's outcome and the override store unchanged", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const s = fakeOverrideStore([forked()]);
    const res = await new SaveOutletOverride(s, () => "T2", throwing).run({ ...fork, approve: true });
    expect(res).toMatchObject({ status: "approved", approvedAt: "T2" });
    expect(s.rows()[0]).toMatchObject({ status: "approved" });
  });

  it("no lineage store injected = the override store is never read before a revert", async () => {
    const s = fakeOverrideStore([forked()]);
    let reads = 0;
    const counted = { ...s, loadAll: async () => { reads++; return s.loadAll(); } };
    await expect(new SaveOutletOverride(counted, () => "T").run({ ...fork, revert: true })).resolves.toBeUndefined();
    expect(reads).toBe(0); // the read exists to feed the lineage; with no lineage it is pure cost
    expect(s.rows()).toEqual([]);
  });

  /**
   * With no lineage wired there is nothing to write and nothing to warn about. Without the guard in
   * `writeFork` the missing store surfaces as a TypeError that `appendFork` catches and logs — a
   * silent behaviour change that no outcome assertion can see, so the log is what pins it.
   */
  it("logs nothing when no lineage store is wired", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = fakeOverrideStore();
      await new SaveOutletOverride(s, () => "T").run({ ...fork, text: "이 방 전용" });
      await new SaveOutletOverride(s, () => "T2").run({ ...fork, approve: true });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
