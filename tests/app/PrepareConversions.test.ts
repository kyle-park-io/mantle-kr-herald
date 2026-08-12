import { describe, it, expect } from "vitest";
import { PrepareConversions } from "../../src/app/PrepareConversions";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ConversionConfig } from "../../src/ports/ConversionConfig";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import { ALL_TYPES, type ConversionType } from "../../src/domain/conversion/models";
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
const fewShotByType = (): Record<ConversionType, FewShotStore> => {
  const byType = {} as Record<ConversionType, FewShotStore>;
  for (const t of ALL_TYPES) byType[t] = emptyFewShot();
  return byType;
};
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
    // x:2 is not approved → excluded; x:1 approved → every type except x, which is already converted.
    // Derived from ALL_TYPES so adding a type extends the expectation instead of breaking it, while
    // still pinning the exact set and order — a leaked x:2, or an unskipped x, still fails.
    const expectedTypes = ALL_TYPES.filter((t) => t !== "x");
    expect(pending).toEqual(expectedTypes.map((type) => ({ itemId: "x:1", type, sourceKorean: "승인 카피" })));
    for (const type of expectedTypes) expect(worksheet, `guide for ${type}`).toContain(`guide-${type}`);
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
    // 2 items selected × ALL_TYPES; pr present for both selected items
    expect(pending).toHaveLength(2 * ALL_TYPES.length);
    expect(pending.filter((p) => p.type === "pr").map((p) => p.itemId)).toEqual(["x:1", "x:2"]);
  });

  it("does not spend --limit on an approved item that has nothing left to convert", async () => {
    // 2026-08-12: two items approved a few seconds apart, `--limit 1` (the scheduler's batch). The
    // tick converted the first, and every tick for the next three hours prepared 0 — the limit was
    // counted before the already-converted items were dropped, so the finished item held the only
    // slot until 되돌리기 or a retire moved it off `approved`. The second item never converted, and
    // so never reached 2차 검수 at all.
    const done = ALL_TYPES.map((type) => `x:1:${type}`);
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "이미 변환됨"), tr("x:2", "approved", "아직 변환 안 됨")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(done),
    );
    const { pending } = await uc.run({ limit: 1 });
    expect(pending).toEqual(ALL_TYPES.map((type) => ({ itemId: "x:2", type, sourceKorean: "아직 변환 안 됨" })));
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

  it("never offers a posted translation for conversion", async () => {
    // A `posted` item was already retired by the reconcile flow — offering it back for conversion
    // would let it re-enter a pipeline whose whole job is to stop it being sent again.
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피"), tr("x:2", "posted", "이미 게시됨")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ types: ["x"] });
    expect(pending).toEqual([{ itemId: "x:1", type: "x", sourceKorean: "승인 카피" }]);
  });
});
