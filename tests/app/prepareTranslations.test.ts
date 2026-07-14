import { describe, it, expect } from "vitest";
import { PrepareTranslations } from "../../src/app/PrepareTranslations";
import type { ContentSource } from "../../src/ports/ContentSource";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ContentItem } from "../../src/domain/translation/contentItem";

function item(id: string, createdAt: string): ContentItem {
  return { id, source: id.startsWith("x") ? "x" : "lark", text: `text-${id}`, createdAt };
}

function deps(pending: ContentItem[], translated: string[] = []) {
  const source: ContentSource = { loadPending: async (ids) => pending.filter((p) => !ids.has(p.id)) };
  const glossaryStore: GlossaryStore = { load: async () => [{ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" }], upsertEntry: async () => {} };
  const fewShotStore: FewShotStore = { load: async () => [], add: async () => {} };
  const config: TranslationConfig = { loadStyleGuide: async () => ({ text: "STYLE" }), loadLocale: async () => ({ dateFormat: "d", numberFormat: "n", currency: "USD", unit: "m", honorific: "합니다체" }) };
  const translationStore: TranslationStore = { loadAll: async () => [], upsert: async () => {}, listTranslatedIds: async () => new Set(translated) };
  return { source, glossaryStore, fewShotStore, config, translationStore };
}

describe("PrepareTranslations", () => {
  it("assembles a worksheet with one shared context + a block per pending item", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("lark:2", "2026-01-02T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, "ROLE");
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
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore);
    const { pending } = await uc.run({ limit: 5 });
    expect(pending).toHaveLength(5);
    expect(pending.some((p) => p.id === "x:0")).toBe(false);
  });

  it("filters by ids and since when given", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("x:2", "2026-06-01T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore);
    expect((await uc.run({ ids: ["x:2"] })).pending.map((p) => p.id)).toEqual(["x:2"]);
    expect((await uc.run({ since: "2026-03-01T00:00:00.000Z" })).pending.map((p) => p.id)).toEqual(["x:2"]);
  });
});
