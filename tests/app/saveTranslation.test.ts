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

  it("saves and approves an oversized (article-length) translation, but skips few-shot promotion", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const hugeSource = "x".repeat(2001); // one char over the promotion threshold
    const res = await uc.run({ itemId: "x:article", source: "x", sourceText: hugeSource, koreanText: "번역", approve: true });

    expect(res).toEqual({ itemId: "x:article", promoted: false });
    // The translation itself still saves and approves normally.
    expect(s.saved[0].status).toBe("approved");
    expect(s.saved[0].approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(s.saved[0].sourceText).toBe(hugeSource);
    // Only the few-shot promotion is skipped.
    expect(s.fewShots).toHaveLength(0);
  });

  it("still promotes a translation right at the threshold", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const atThreshold = "x".repeat(2000);
    const res = await uc.run({ itemId: "x:2", source: "x", sourceText: atThreshold, koreanText: "번역", approve: true });

    expect(res.promoted).toBe(true);
    expect(s.fewShots).toHaveLength(1);
  });
});
