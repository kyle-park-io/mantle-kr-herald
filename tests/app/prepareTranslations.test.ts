import { describe, it, expect } from "vitest";
import { PrepareTranslations } from "../../src/app/PrepareTranslations";
import type { ContentSource } from "../../src/ports/ContentSource";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ContentItem } from "../../src/domain/translation/contentItem";

function item(id: string, createdAt: string, author?: string): ContentItem {
  return { id, source: id.startsWith("x") ? "x" : "lark", text: `text-${id}`, createdAt, author };
}

function deps(pending: ContentItem[], translated: string[] = []) {
  const source: ContentSource = { loadPending: async (ids) => pending.filter((p) => !ids.has(p.id)) };
  const glossaryStore: GlossaryStore = { load: async () => [{ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" }], upsertEntry: async () => {} };
  const fewShotStore: FewShotStore = { load: async () => [], add: async () => {} };
  const tmStore: FewShotStore = { load: async () => [], add: async () => {} };
  const config: TranslationConfig = { loadStyleGuide: async () => ({ text: "STYLE" }), loadLocale: async () => ({ dateFormat: "d", numberFormat: "n", currency: "USD", unit: "m", honorific: "합니다체" }) };
  const translationStore: TranslationStore = { loadAll: async () => [], upsert: async () => {}, listTranslatedIds: async () => new Set(translated) };
  return { source, glossaryStore, fewShotStore, tmStore, config, translationStore };
}

describe("PrepareTranslations", () => {
  it("assembles a worksheet with one shared context + a block per pending item", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("lark:2", "2026-01-02T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore, "ROLE");
    const { worksheet, pending } = await uc.run({});
    expect(pending.map((p) => p.id)).toEqual(["x:1", "lark:2"]);
    expect(worksheet.match(/## ① 역할/g)).toHaveLength(1); // shared context once
    expect(worksheet).toContain("ROLE");
    expect(worksheet).toContain("text-x:1");
    expect(worksheet).toContain("text-lark:2");
  });

  it("excludes already-translated ids and applies the limit", async () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`x:${i}`, "2026-01-01T00:00:00.000Z"));
    const d = deps(items, ["x:0"]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
    const { pending } = await uc.run({ limit: 5 });
    expect(pending).toHaveLength(5);
    expect(pending.some((p) => p.id === "x:0")).toBe(false);
  });

  it("filters by ids and since when given", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("x:2", "2026-06-01T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
    expect((await uc.run({ ids: ["x:2"] })).pending.map((p) => p.id)).toEqual(["x:2"]);
    expect((await uc.run({ since: "2026-03-01T00:00:00.000Z" })).pending.map((p) => p.id)).toEqual(["x:2"]);
  });

  /**
   * `since` is the translate floor — `HERALD_TRANSLATE_SINCE` on `herald-watch.service`, handed
   * straight to this selector by every scheduled tick. It exists to stop the *swept timeline's*
   * whole history draining into translation, and one hand-picked link is not that risk, so it gates
   * the swept account (`SWEPT_ACCOUNT`) and nobody else — see the spec's "번역 기준 시각과의 관계".
   *
   * This is the half that makes 링크 수집's waiting list honest: without it a linked post older than
   * the floor was collected, listed as waiting, and then silently filtered out here forever.
   */
  describe("the translate floor applies to the swept account only", () => {
    const FLOOR = "2026-07-27T14:35:25.000Z"; // the live value, deploy/herald-watch.service
    const BEFORE = "2026-07-01T00:00:00.000Z";

    it("filters out a below-floor item from the account the sweep reads", async () => {
      const d = deps([item("x:1", BEFORE, "Mantle_Official")]);
      const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
      expect((await uc.run({ since: FLOOR })).pending).toEqual([]);
    });

    it("keeps a below-floor item from any other account — it can only have been hand-picked", async () => {
      // Nothing but 링크 수집 puts another account's post in `x_threads`, so there is no backlog
      // behind this item for the floor to hold back.
      const d = deps([item("x:2", BEFORE, "someone_else")]);
      const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
      expect((await uc.run({ since: FLOOR })).pending.map((p) => p.id)).toEqual(["x:2"]);
    });

    it("compares the handle case-insensitively", async () => {
      // An X handle is not case-sensitive, so `@mantle_official` is the swept account and must not
      // slip past the floor by spelling alone.
      const d = deps([item("x:3", BEFORE, "mantle_official")]);
      const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
      expect((await uc.run({ since: FLOOR })).pending).toEqual([]);
    });

    it("filters out a below-floor item whose author cannot be read", async () => {
      // The conservative default, and it is not a detail: a Lark item, or an X item stored before
      // the author was carried, opens the whole historical backlog if "unknown" reads as "not the
      // swept account". Shut is at worst what this did before the rule existed.
      const d = deps([item("lark:4", BEFORE), item("x:5", BEFORE, "")]);
      const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
      expect((await uc.run({ since: FLOOR })).pending).toEqual([]);
    });

    it("leaves the swept account's own at-or-after-floor items alone", async () => {
      const d = deps([item("x:6", FLOOR, "Mantle_Official")]);
      const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
      expect((await uc.run({ since: FLOOR })).pending.map((p) => p.id)).toEqual(["x:6"]);
    });
  });

  it("caps rendered few-shots to the most recent N, dropping the oldest", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z")]);
    const manyFewShots = Array.from({ length: 10 }, (_, i) => ({ source: `f${i}`, target: `번역${i}` }));
    d.fewShotStore.load = async () => manyFewShots;
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
    const { worksheet } = await uc.run({});
    expect(worksheet).toContain("f9");
    expect(worksheet).not.toContain("f0");
  });

  it("inlines TM pairs relevant to the batch and drops irrelevant ones", async () => {
    const d = deps([]);
    // one pending item mentioning $MNT / #Mantle
    d.source.loadPending = async () => [
      { id: "x:1", source: "x", text: "$MNT staking live #Mantle", createdAt: "2026-07-20T00:00:00Z" },
    ];
    d.tmStore.load = async () => [
      { source: "$MNT rewards #Mantle", target: "리워드 소식", itemId: "x:a" }, // shares 2 anchors
      { source: "unrelated $OTHER", target: "무관", itemId: "x:b" }, // shares 0
    ];
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
    const { worksheet } = await uc.run({});
    expect(worksheet).toContain("리워드 소식"); // relevant TM pair inlined
    expect(worksheet).not.toContain("무관"); // irrelevant TM pair excluded
  });
});
