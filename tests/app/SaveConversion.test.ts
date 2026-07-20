import { describe, it, expect } from "vitest";
import { SaveConversion } from "../../src/app/SaveConversion";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import { ALL_TYPES, type ContentVariant, type ConversionType } from "../../src/domain/conversion/models";
import type { FewShotExample } from "../../src/domain/translation/models";

function harness() {
  const saved: ContentVariant[] = [];
  const store: ConversionStore = {
    loadAll: async () => saved, listConvertedKeys: async () => new Set(),
    upsert: async (v) => { saved.push(v); },
  };
  const fewShots = {} as Record<ConversionType, FewShotExample[]>;
  for (const t of ALL_TYPES) fewShots[t] = [];
  const mk = (t: ConversionType): FewShotStore => ({ load: async () => fewShots[t], add: async (e) => { fewShots[t].push(e); } });
  const fewShotByType = {} as Record<ConversionType, FewShotStore>;
  for (const t of ALL_TYPES) fewShotByType[t] = mk(t);
  return { saved, fewShots, store, fewShotByType };
}

describe("SaveConversion", () => {
  it("saves as converted without approval and does not touch few-shot", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, h.fewShotByType, () => "2026-02-02T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", approve: false });
    expect(res).toEqual({ itemId: "x:1", type: "x", promoted: false });
    expect(h.saved[0].status).toBe("converted");
    expect(h.saved[0].approvedAt).toBeUndefined();
    expect(h.fewShots.x).toHaveLength(0);
  });

  it("approves → status approved + appends to that type's few-shot only", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, h.fewShotByType, () => "2026-02-02T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "kol", sourceKorean: "한글", convertedText: "브리프", approve: true });
    expect(res.promoted).toBe(true);
    expect(h.saved[0].status).toBe("approved");
    expect(h.saved[0].approvedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(h.fewShots.kol).toEqual([{ source: "한글", target: "브리프", itemId: "x:1" }]);
    expect(h.fewShots.x).toHaveLength(0);
  });
});
