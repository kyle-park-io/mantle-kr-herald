import { describe, it, expect } from "vitest";
import { SaveTranslation } from "../../src/app/SaveTranslation";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { Translation, FewShotExample } from "../../src/domain/translation/models";

function stores() {
  const saved: Translation[] = [];
  const fewShots: FewShotExample[] = [];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => { saved.push(t); },
    listTranslatedIds: async () => new Set(saved.map((t) => t.itemId)),
  };
  const fewShotStore: FewShotStore = { load: async () => fewShots, add: async (ex) => { fewShots.push(ex); } };
  return { saved, fewShots, translationStore, fewShotStore };
}

describe("SaveTranslation", () => {
  it("stores a translation with status 'translated' and does not promote when not approved", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
    expect(s.saved[0].status).toBe("translated");
    expect(s.saved[0].translatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(s.fewShots).toHaveLength(0);
  });

  it("marks approved and promotes to few-shot when approved", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: true });
    expect(res.promoted).toBe(true);
    expect(s.saved[0].status).toBe("approved");
    expect(s.saved[0].approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(s.fewShots).toEqual([{ source: "hi", target: "안녕", itemId: "x:1" }]);
  });
});
