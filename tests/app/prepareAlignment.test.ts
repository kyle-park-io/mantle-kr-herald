import { describe, it, expect } from "vitest";
import { PrepareAlignment } from "../../src/app/PrepareAlignment";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { Translation, FewShotExample } from "../../src/domain/translation/models";

function translation(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "gm $MNT", koreanText: "지엠", status: "translated", translatedAt: "2026-07-20T00:00:00.000Z", ...over };
}

function stores(translations: Translation[], tm: FewShotExample[]) {
  const translationStore: TranslationStore = {
    loadAll: async () => translations,
    upsert: async () => {},
    listTranslatedIds: async () => new Set(),
  };
  const tmStore: FewShotStore = { load: async () => tm, add: async () => {} };
  return { translationStore, tmStore };
}

describe("PrepareAlignment", () => {
  it("aligns only translated drafts that have a precedent; skips precedentless, excludes approved", async () => {
    const s = stores(
      [
        translation({ itemId: "x:1", sourceText: "gm $MNT", status: "translated" }), // precedent → aligned
        translation({ itemId: "x:2", sourceText: "no anchors here", status: "translated" }), // no precedent → skip
        translation({ itemId: "x:3", sourceText: "gm $MNT", status: "approved" }), // approved → excluded entirely
      ],
      [{ source: "gm $MNT fam", target: "안녕" }],
    );
    const res = await new PrepareAlignment(s.translationStore, s.tmStore).run({});
    expect(res.aligned).toBe(1);
    expect(res.skipped).toBe(1); // x:2 only — x:3 is filtered before the precedent lookup
    expect(res.worksheet).toContain("### x:1");
    expect(res.worksheet).not.toContain("### x:2");
    expect(res.worksheet).not.toContain("### x:3");
  });

  it("filters by --ids", async () => {
    const s = stores(
      [translation({ itemId: "x:1" }), translation({ itemId: "x:2" })],
      [{ source: "gm $MNT fam", target: "안녕" }],
    );
    const res = await new PrepareAlignment(s.translationStore, s.tmStore).run({ ids: ["x:2"] });
    expect(res.aligned).toBe(1);
    expect(res.worksheet).toContain("### x:2");
    expect(res.worksheet).not.toContain("### x:1");
  });
});
