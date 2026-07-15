import { describe, it, expect } from "vitest";
import { PrepareConversions } from "../../src/app/PrepareConversions";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ConversionConfig } from "../../src/ports/ConversionConfig";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { ConversionType } from "../../src/domain/conversion/models";
import type { Translation, Locale } from "../../src/domain/translation/models";

const locale: Locale = { dateFormat: "d", numberFormat: "n", currency: "USD", unit: "u", honorific: "합니다체" };

function tr(itemId: string, status: Translation["status"], ko: string): Translation {
  return { itemId, source: "x", sourceText: `src-${itemId}`, koreanText: ko, status, translatedAt: "2026-01-01T00:00:00.000Z",
    approvedAt: status === "approved" ? "2026-01-02T00:00:00.000Z" : undefined };
}
const translationStore = (list: Translation[]): TranslationStore => ({
  loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set(),
});
const glossaryStore: GlossaryStore = { load: async () => [], upsertEntry: async () => {} };
const config: TranslationConfig = { loadStyleGuide: async () => ({ text: "" }), loadLocale: async () => locale };
const conversionConfig: ConversionConfig = { loadTypeGuide: async (t) => ({ text: `guide-${t}` }) };
const emptyFewShot = (): FewShotStore => ({ load: async () => [], add: async () => {} });
const fewShotByType = (): Record<ConversionType, FewShotStore> => ({ x: emptyFewShot(), kol: emptyFewShot(), pr: emptyFewShot() });
const convStore = (keys: string[] = []): ConversionStore => ({
  loadAll: async () => [], upsert: async () => {}, listConvertedKeys: async () => new Set(keys),
});

describe("PrepareConversions", () => {
  it("fans approved translations into all types by default, skipping already-converted (itemId,type)", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피"), tr("x:2", "translated", "미승인")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(["x:1:x"]),
    );
    const { worksheet, pending } = await uc.run({});
    // x:2 is not approved → excluded; x:1 approved → kol + pr (x already converted)
    expect(pending).toEqual([
      { itemId: "x:1", type: "kol", sourceKorean: "승인 카피" },
      { itemId: "x:1", type: "pr", sourceKorean: "승인 카피" },
    ]);
    expect(worksheet).toContain("guide-kol");
    expect(worksheet).toContain("guide-pr");
    expect(worksheet).not.toContain("## 유형: X");
    expect(worksheet).toContain("승인 카피");
  });

  it("honors --types and --ids and --limit", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "a"), tr("x:2", "approved", "b")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ types: ["x"], ids: ["x:2"], limit: 5 });
    expect(pending).toEqual([{ itemId: "x:2", type: "x", sourceKorean: "b" }]);
  });

  it("counts --limit by source item, keeping all types for each selected item (no type dropped)", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "a"), tr("x:2", "approved", "b"), tr("x:3", "approved", "c")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ limit: 2 });
    // 2 items selected × 3 types = 6 variants; pr present for both selected items
    expect(pending).toHaveLength(6);
    expect(pending.filter((p) => p.type === "pr").map((p) => p.itemId)).toEqual(["x:1", "x:2"]);
  });

  it("filters by since against approvedAt (older items excluded)", async () => {
    const older = tr("x:1", "approved", "old"); // approvedAt 2026-01-02
    const newer = { ...tr("x:2", "approved", "new"), approvedAt: "2026-06-01T00:00:00.000Z" };
    const uc = new PrepareConversions(
      translationStore([older, newer]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ types: ["x"], since: "2026-03-01T00:00:00.000Z" });
    expect(pending).toEqual([{ itemId: "x:2", type: "x", sourceKorean: "new" }]);
  });
});
