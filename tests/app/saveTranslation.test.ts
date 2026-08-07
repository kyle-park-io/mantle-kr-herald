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

/** Like `stores()` above, but `upsert` replaces by itemId the way a real store does. */
function replacingStores(seed: Translation[] = []) {
  const saved = [...seed];
  const fewShots: FewShotExample[] = [];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => {
      const i = saved.findIndex((x) => x.itemId === t.itemId);
      if (i >= 0) saved[i] = t;
      else saved.push(t);
    },
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
    expect(res).toEqual({ itemId: "x:1", promoted: false, normalizedPhotoMarkers: 0 });
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

    expect(res).toEqual({ itemId: "x:article", promoted: false, normalizedPhotoMarkers: 0 });
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

  it("stores isReply and refUrl on the translation when provided", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    await uc.run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕",
      approve: false, isReply: true, refUrl: "https://x.com/a/status/1",
    });
    expect(s.saved[0].isReply).toBe(true);
    expect(s.saved[0].refUrl).toBe("https://x.com/a/status/1");
  });

  it("restores the [사진] label the agent dropped, and reports how many", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({
      itemId: "x:1", source: "x", sourceText: "hi\n\n[사진](https://img/a.jpg)",
      koreanText: "안녕\n\n![](https://img/a.jpg)", approve: false,
    });

    expect(s.saved[0].koreanText).toBe("안녕\n\n[사진](https://img/a.jpg)");
    expect(res.normalizedPhotoMarkers).toBe(1);
  });

  it("reports zero when the translation already carries the label", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕\n\n[사진](https://img/a.jpg)", approve: false,
    });
    expect(res.normalizedPhotoMarkers).toBe(0);
  });

  it("promotes the normalized text into the few-shot corpus, not the agent's spelling", async () => {
    // The corpus is inlined into every later worksheet, so promoting `![]` would teach the next
    // batch to produce it — the drift would train itself in.
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    await uc.run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕\n\n![](https://img/a.jpg)", approve: true,
    });
    expect(s.fewShots[0].target).toBe("안녕\n\n[사진](https://img/a.jpg)");
  });

  it("does not clear postedUrl or postedAt when an edit is saved", async () => {
    // `run` builds a whole new Translation and upserts it, so without care the retire evidence is
    // silently dropped — and losing postedUrl means the next reconcile re-retires an item a human
    // deliberately reverted.
    const retired: Translation = {
      itemId: "x:1",
      source: "x",
      sourceText: "hi",
      koreanText: "안녕",
      status: "posted",
      translatedAt: "2026-05-05T00:00:00.000Z",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-07-31T05:39:41.000Z",
    };
    const s = replacingStores([retired]);
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-06T00:00:00.000Z");

    await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕하세요", approve: false });

    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].koreanText).toBe("안녕하세요");
    expect(s.saved[0].status).toBe("translated"); // the revert path: off `posted`…
    expect(s.saved[0].postedUrl).toBe("https://x.com/0xMantleKR/status/999"); // …but the evidence stays
    expect(s.saved[0].postedAt).toBe("2026-07-31T05:39:41.000Z");
  });
});
