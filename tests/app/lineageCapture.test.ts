import { describe, it, expect } from "vitest";
import { SaveTranslation } from "../../src/app/SaveTranslation";
import { SaveRendering } from "../../src/app/SaveRendering";
import type { LineageStore, LineageSummary } from "../../src/ports/LineageStore";
import type { LineageEntry } from "../../src/domain/lineage/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";

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

  it("a lineage append failure is swallowed — the save still succeeds", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T", throwing).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
  });

  it("no lineage store injected = no append, unchanged behavior", async () => {
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T").run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
  });
});
