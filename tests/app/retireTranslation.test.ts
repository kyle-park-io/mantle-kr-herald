import { describe, expect, it, vi } from "vitest";
import { RetireTranslation } from "../../src/app/RetireTranslation";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";

const RETIRE = { itemId: "x:1", rootId: "100", url: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" };

function fixture(over: Partial<Translation> = {}) {
  const calls: string[] = [];
  const saved: Translation[] = [
    { itemId: "x:1", source: "x", sourceText: "en", koreanText: "안녕", status: "translated", translatedAt: "2026-08-01T00:00:00.000Z", ...over },
  ];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => {
      calls.push("status");
      saved[saved.findIndex((x) => x.itemId === t.itemId)] = t;
    },
    listTranslatedIds: async () => new Set(saved.map((t) => t.itemId)),
  };
  const recorded: unknown[] = [];
  const publisher = { record: vi.fn(async (r: unknown) => { calls.push("history"); recorded.push(r); }) };
  return { calls, saved, recorded, publisher, translationStore };
}

describe("RetireTranslation", () => {
  it("sets status to posted and stamps postedUrl and postedAt", async () => {
    const f = fixture();
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("retired");
    expect(f.saved[0]).toMatchObject({ status: "posted", postedUrl: RETIRE.url, postedAt: RETIRE.postedAt });
  });

  it("returns already-retired and writes no status when postedUrl is already set", async () => {
    const f = fixture({ postedUrl: RETIRE.url, status: "posted" });
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("already-retired");
    expect(f.calls).not.toContain("status");
  });

  it("writes the status BEFORE the history row", async () => {
    // Load-bearing. A history row written first makes the next reconcile skip the item via
    // historyPostIds, leaving it permanently unretireable if the status write then fails.
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(f.calls).toEqual(["status", "history"]);
  });

  it("still reports the retire when the history write throws, so the next run retries the row", async () => {
    const f = fixture();
    f.publisher.record.mockRejectedValueOnce(new Error("HTTP 500"));
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("retired");
    expect(f.saved[0].status).toBe("posted");
  });

  it("keys the history row x:<itemId>, not kr:<rootId>", async () => {
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(f.recorded[0]).toMatchObject({
      itemId: "x:1",
      type: "x",
      channel: "x",
      outletId: "x-post",
      postId: "100",
      status: "posted",
      publishedAt: RETIRE.postedAt,
    });
  });

  it("skips the history row when the postId is already recorded under another itemId", async () => {
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set(["100"])).run(RETIRE);
    expect(f.publisher.record).not.toHaveBeenCalled();
    expect(f.saved[0].status).toBe("posted"); // the retire still happens
  });
});
