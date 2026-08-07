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
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
    expect(res).toEqual({ status: "retired", history: "written" });
    expect(f.saved[0]).toMatchObject({ status: "posted", postedUrl: RETIRE.url, postedAt: RETIRE.postedAt });
  });

  it("writes the status BEFORE the history row", async () => {
    // Load-bearing when both halves succeed. A history row landing first would appear in
    // historyPostIds on the very next run while the translation still lacked postedUrl — a state
    // reconcileXPublished's conjunctive skip can never produce on its own, so nothing would
    // re-drive a failed status write.
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
    expect(f.calls).toEqual(["status", "history"]);
  });

  it("keys the history row x:<itemId>, not kr:<rootId>", async () => {
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
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
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(["100"])).run(RETIRE);
    expect(res).toEqual({ status: "retired", history: "skipped" });
    expect(f.publisher.record).not.toHaveBeenCalled();
    expect(f.saved[0].status).toBe("posted"); // the retire still happens
  });

  describe("Finding 1 — status and history are independent, so a stuck history write is retryable", () => {
    it("already-retired (postedUrl set) still attempts the history write when it is still missing", async () => {
      // The core of the fix: a translation retired in an EARLIER run (postedUrl already set) whose
      // history write never landed must not be permanently stuck just because the status half is
      // now a no-op.
      const f = fixture({ postedUrl: RETIRE.url, status: "posted" });
      const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
      expect(res).toEqual({ status: "already-retired", history: "written" });
      expect(f.calls).not.toContain("status"); // no upsert — the status half is genuinely a no-op
      expect(f.calls).toContain("history");
    });

    it("already-retired reports history as skipped, without calling publisher, once historyPostIds has the rootId", async () => {
      // Genuinely done on both halves — nothing left to retry.
      const f = fixture({ postedUrl: RETIRE.url, status: "posted" });
      const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set([RETIRE.rootId])).run(RETIRE);
      expect(res).toEqual({ status: "already-retired", history: "skipped" });
      expect(f.publisher.record).not.toHaveBeenCalled();
    });

    it("reports history: failed (not thrown) when the history write throws, and the status write still stands", async () => {
      const f = fixture();
      f.publisher.record.mockRejectedValueOnce(new Error("HTTP 500"));
      const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
      expect(res).toEqual({ status: "retired", history: "failed" });
      expect(f.saved[0].status).toBe("posted");
    });

    it("mutation-check: a history write that throws on one run is retried and succeeds on the next", async () => {
      // Two separate RetireTranslation instances (fresh `historyPostIds`, like two separate
      // `x:reconcile` runs), same underlying `translationStore` — models exactly what the CLI does
      // across two ticks when the first tick's history write fails and reconcileXPublished's
      // conjunctive skip re-admits the translation to plan.posted on the next tick.
      const f = fixture();
      f.publisher.record.mockRejectedValueOnce(new Error("HTTP 500"));

      const first = await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
      expect(first).toEqual({ status: "retired", history: "failed" });
      expect(f.saved[0].status).toBe("posted");

      // historyPostIds still lacks "100" — the failed write above never landed anywhere for a real
      // caller to have recorded it, matching what reconcileXPublished would compute for this exact
      // situation on a second run.
      const second = await new RetireTranslation(f.translationStore, f.publisher as never, new Set()).run(RETIRE);
      expect(second).toEqual({ status: "already-retired", history: "written" });
      expect(f.publisher.record).toHaveBeenCalledTimes(2);
    });
  });
});
