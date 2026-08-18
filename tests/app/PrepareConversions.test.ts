import { describe, it, expect } from "vitest";
import { PrepareConversions } from "../../src/app/PrepareConversions";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ConversionConfig } from "../../src/ports/ConversionConfig";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import { ALL_TYPES, type ContentVariant, type ConversionType } from "../../src/domain/conversion/models";
import type { Translation, Locale } from "../../src/domain/translation/models";

/** Every type the agent is still asked for — i.e. all of them but the `x` passthrough. */
const REWRITTEN = ALL_TYPES.filter((t) => t !== "x");

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
/** `convStore`, plus the rows it was asked to write — the x passthrough's only observable output. */
function recordingConvStore(keys: string[] = []): { store: ConversionStore; written: ContentVariant[] } {
  const written: ContentVariant[] = [];
  return {
    store: { loadAll: async () => [], upsert: async (v) => { written.push(v); }, listConvertedKeys: async () => new Set(keys) },
    written,
  };
}

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
    const { pending } = await uc.run({ types: ["announcement"], ids: ["x:2"], limit: 5 });
    expect(pending).toEqual([{ itemId: "x:2", type: "announcement", sourceKorean: "b" }]);
  });

  it("counts --limit by source item, keeping all types for each selected item (no type dropped)", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "a"), tr("x:2", "approved", "b"), tr("x:3", "approved", "c")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ limit: 2 });
    // 2 items selected × every rewritten type; pr present for both selected items
    expect(pending).toHaveLength(2 * REWRITTEN.length);
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
    expect(pending).toEqual(REWRITTEN.map((type) => ({ itemId: "x:2", type, sourceKorean: "아직 변환 안 됨" })));
  });

  it("filters by since against approvedAt (older items excluded)", async () => {
    const older = tr("x:1", "approved", "old"); // approvedAt 2026-01-02
    const newer = { ...tr("x:2", "approved", "new"), approvedAt: "2026-06-01T00:00:00.000Z" };
    const uc = new PrepareConversions(
      translationStore([older, newer]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ types: ["announcement"], since: "2026-03-01T00:00:00.000Z" });
    expect(pending).toEqual([{ itemId: "x:2", type: "announcement", sourceKorean: "new" }]);
  });

  it("caps the fan-out at maxVariants, and the worksheet carries only what survived the cap", async () => {
    // 2026-08-17: one item, seven unconverted types, one `claude -p` call under a ten-minute cap.
    // The agent saved five and was killed mid-sixth, and the tick failed. `--limit` cannot express
    // that ceiling — it counts source items, and the item was already one — so the bound has to sit
    // on the pairs the fan-out produces, after it produces them.
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { worksheet, pending } = await uc.run({ maxVariants: 4 });
    expect(pending).toEqual(REWRITTEN.slice(0, 4).map((type) => ({ itemId: "x:1", type, sourceKorean: "승인 카피" })));
    // The worksheet has to be cut with the same knife. It is what the agent reads, and `pending.json`
    // is what the tick counts the agent's saves against — a section for a dropped pair asks the agent
    // to save a variant nobody is expecting, on top of the ones it was actually given.
    for (const type of REWRITTEN.slice(4)) expect(worksheet, `section for ${type}`).not.toContain(`guide-${type}`);
  });

  /**
   * `x` is not a rewrite. The item is a translation of a tweet, so the Korean the 1차 reviewer
   * approved IS the post — handing it to the agent re-opens wording a human already signed off,
   * which is exactly what production had been doing: every one of the ten `x` variants on
   * 2026-08-18 differed from its own `sourceKorean`.
   */
  it("saves the x variant from the approved translation itself, and never asks the agent for it", async () => {
    const { store, written } = recordingConvStore();
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피")]),
      glossaryStore, config, conversionConfig, fewShotByType(), store, () => "2026-05-05T00:00:00.000Z",
    );
    const { worksheet, pending, passthrough } = await uc.run({ types: ["x"] });
    expect(pending).toEqual([]);
    expect(passthrough).toEqual([{ itemId: "x:1", type: "x", sourceKorean: "승인 카피" }]);
    expect(worksheet).not.toContain("guide-x");
    expect(written).toEqual([{
      itemId: "x:1", type: "x", sourceKorean: "승인 카피", convertedText: "승인 카피",
      status: "converted", createdAt: "2026-05-05T00:00:00.000Z",
    }]);
  });

  /**
   * `maxVariants` is arithmetic against `claude -p`'s ten-minute cap (`ConvertTick`), and a
   * passthrough spends none of it — no worksheet section to read, no save to wait for. Counting x
   * against the ceiling would silently cut one rewrite per tick to buy nothing.
   */
  it("does not spend the maxVariants ceiling on x", async () => {
    const { store, written } = recordingConvStore();
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피")]),
      glossaryStore, config, conversionConfig, fewShotByType(), store, () => "2026-05-05T00:00:00.000Z",
    );
    const { pending, passthrough } = await uc.run({ maxVariants: 4 });
    const rewritten = ALL_TYPES.filter((t) => t !== "x");
    expect(pending).toEqual(rewritten.slice(0, 4).map((type) => ({ itemId: "x:1", type, sourceKorean: "승인 카피" })));
    expect(passthrough).toEqual([{ itemId: "x:1", type: "x", sourceKorean: "승인 카피" }]);
    expect(written).toHaveLength(1);
  });

  it("never offers a posted translation for conversion", async () => {
    // A `posted` item was already retired by the reconcile flow — offering it back for conversion
    // would let it re-enter a pipeline whose whole job is to stop it being sent again.
    const { store, written } = recordingConvStore();
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피"), tr("x:2", "posted", "이미 게시됨")]),
      glossaryStore, config, conversionConfig, fewShotByType(), store,
    );
    const { pending, passthrough } = await uc.run({ types: ["x"] });
    expect(pending).toEqual([]);
    // The passthrough writes a variant row without waiting for an agent, so "never offered" has to
    // mean "no row written", not merely "not put on the worksheet".
    expect(passthrough).toEqual([{ itemId: "x:1", type: "x", sourceKorean: "승인 카피" }]);
    expect(written.map((v) => v.itemId)).toEqual(["x:1"]);
  });
});
