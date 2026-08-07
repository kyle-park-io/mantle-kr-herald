import { describe, it, expect } from "vitest";
import { CapturePublishedText } from "../../src/app/CapturePublishedText";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";

function store(seed: Translation[]) {
  const rows = [...seed];
  const s: TranslationStore = {
    loadAll: async () => rows,
    upsert: async (t) => {
      const i = rows.findIndex((r) => r.itemId === t.itemId);
      if (i >= 0) rows[i] = t; else rows.push(t);
    },
    listTranslatedIds: async () => new Set(rows.map((r) => r.itemId)),
  };
  return { rows, s };
}

const settled = (over: Partial<Translation> = {}): Translation => ({
  itemId: "x:1", source: "x", sourceText: "en", koreanText: "우리 초안",
  status: "posted", translatedAt: "2026-08-01T00:00:00.000Z",
  postedUrl: "https://x.com/0xMantleKR/status/999", postedAt: "2026-08-02T00:00:00.000Z", ...over,
});

describe("CapturePublishedText", () => {
  it("writes the published text and reports it as captured", async () => {
    const { rows, s } = store([settled()]);
    const result = await new CapturePublishedText(s).run({ itemId: "x:1", text: "올라간 글" });
    expect(result).toBe("captured");
    expect(rows[0].publishedText).toBe("올라간 글");
  });

  it("leaves every other field on the row untouched", async () => {
    // The whole-row upsert means a fresh object here would drop status/postedUrl/postedAt.
    const { rows, s } = store([settled({ approvedAt: "2026-08-01T12:00:00.000Z", refUrl: "https://x.com/a/status/1" })]);
    await new CapturePublishedText(s).run({ itemId: "x:1", text: "올라간 글" });
    expect(rows[0]).toMatchObject({
      status: "posted",
      koreanText: "우리 초안",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-08-02T00:00:00.000Z",
      approvedAt: "2026-08-01T12:00:00.000Z",
      refUrl: "https://x.com/a/status/1",
    });
  });

  it("does not overwrite a value that is already there", async () => {
    const { rows, s } = store([settled({ publishedText: "이미 있음" })]);
    const result = await new CapturePublishedText(s).run({ itemId: "x:1", text: "다른 글" });
    expect(result).toBe("already-present");
    expect(rows[0].publishedText).toBe("이미 있음");
  });

  it("writes nothing at all when the value is already there", async () => {
    // Not just "the value is unchanged" — no upsert may be issued, or a concurrent edit is clobbered.
    let upserts = 0;
    const { s } = store([settled({ publishedText: "이미 있음" })]);
    const counting: TranslationStore = { ...s, upsert: async (t) => { upserts++; await s.upsert(t); } };
    await new CapturePublishedText(counting).run({ itemId: "x:1", text: "다른 글" });
    expect(upserts).toBe(0);
  });

  it("throws for an itemId that has no row", async () => {
    const { s } = store([]);
    await expect(new CapturePublishedText(s).run({ itemId: "x:missing", text: "올라간 글" }))
      .rejects.toThrow(/x:missing/);
  });
});
