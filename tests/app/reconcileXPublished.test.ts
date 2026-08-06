// tests/app/reconcileXPublished.test.ts
import { describe, it, expect } from "vitest";
import { reconcileXPublished, xMatchCandidates } from "../../src/app/ReconcileXPublished";
import { CANDIDATE_AT } from "../../src/domain/publish/xReconcile";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function thread(rootId: string, texts: string[]): AssembledThread {
  const tweets = texts.map(
    (text, i) =>
      ({
        id: i === 0 ? rootId : `${rootId}${i}`,
        conversationId: rootId,
        text,
        createdAt: "2026-08-01T00:00:00.000Z",
        authorUserName: "0xMantleKR",
      }) as SourceTweet,
  );
  return { rootId, tweets };
}

const COPY = "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 완전한 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

function rendering(itemId: string, text: string, over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId, type: "x", channel: "x", text, status: "approved", ...over } as ChannelRendering;
}

const base = { deliveredKeys: new Set<string>(), historyIds: new Set<string>(), handle: "0xMantleKR" };

describe("xMatchCandidates", () => {
  it("takes only approved x copy", () => {
    // An unapproved rendering is not something a human signed off, and telegram copy is a different
    // channel entirely — matching against either would attribute a live post to the wrong thing.
    const candidates = xMatchCandidates([
      rendering("x:ok", COPY),
      rendering("x:draft", COPY, { status: "rendered" }),
      rendering("x:tg", COPY, { channel: "telegram" }),
      rendering("x:empty", ""),
    ]);
    expect(candidates.map((c) => c.itemId)).toEqual(["x:ok"]);
  });
});

describe("reconcileXPublished", () => {
  it("confirms a pasted post and leaves everything else external", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY]), thread("200", ["당첨자 발표 이벤트 안내입니다. 참여해 주신 모든 분께 감사드립니다."])],
      renderings: [rendering("x:1", COPY)],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.itemId).toBe("x:1");
    expect(plan.confirmed[0].entry.postId).toBe("100");
    expect(plan.external.map((e) => e.record.itemId)).toEqual(["kr:200"]);
    expect(plan.candidates).toEqual([]);
  });

  it("carries a near-miss's real score, not a flat zero indistinguishable from no candidates at all", () => {
    // Task 1's own fixture: a 40-character prefix of COPY scores 0.46774193548387094 against it —
    // above MATCH_THRESHOLD (0.3, so classify does a real comparison) but below CANDIDATE_AT (0.5,
    // so the verdict is still external). Without carrying this score through, that near-miss and a
    // thread with zero candidates would produce identical rows, and a human reading the plan could
    // not tell "nothing was close" apart from "this nearly matched something we approved."
    const nearMiss = COPY.slice(0, 40);
    const plan = reconcileXPublished({ ...base, threads: [thread("500", [nearMiss])], renderings: [rendering("x:1", COPY)] });

    expect(plan.external).toHaveLength(1);
    expect(plan.external[0].record.itemId).toBe("kr:500");
    expect(plan.external[0].score).toBeGreaterThan(0);
    expect(plan.external[0].score).toBeLessThan(CANDIDATE_AT);
  });

  it("carries the matched rendering's own type, not a literal", () => {
    // Every other fixture in this file uses the `rendering()` helper's default `type: "x"`, which
    // would let a regression hard-coding "x" at the confirm site pass unnoticed. Use a rendering
    // typed "kol" instead — a real ConversionType, just not the one every other test happens to use.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY, { type: "kol" })],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.type).toBe("kol");
  });

  it("refuses to confirm when the itemId's type is ambiguous, and reports a candidate instead", () => {
    // Two approved channel: "x" renderings sharing one itemId but differing in type — reachable
    // today via a --channels/API override on FormatVariants/PrepareRefinements, not just "in
    // principle". bestMatch only proves the itemId; it cannot say which of the two types is right,
    // and type is part of deliveryKey, so guessing could write a delivery row under the wrong key
    // and leave send:channels free to post the real (itemId, type, x-post) again. Refusing costs
    // one human confirmation instead of an unrecoverable duplicate `sent` row.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY, { type: "kol" }), rendering("x:1", COPY, { type: "announcement" })],
    });

    expect(plan.confirmed).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].rootId).toBe("100");
    expect(plan.candidates[0].itemId).toBe("x:1");
  });

  it("skips a thread whose item already has an x-post delivery row", () => {
    // Idempotency: a second run must be a no-op. This is also what protects the two pre-existing
    // rows recording real sends to @bcd_kyle — they are history, not something to correct.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      deliveredKeys: new Set(["x:1:x:x-post"]),
    });

    expect(plan.confirmed).toEqual([]);
    expect(plan.external).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].rootId).toBe("100");
  });

  it("skips an external post already in publish history", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("300", ["파이프라인과 무관한 한국팀 자체 공지입니다."])],
      renderings: [],
      historyIds: new Set(["kr:300"]),
    });

    expect(plan.external).toEqual([]);
    expect(plan.skipped.map((s) => s.rootId)).toEqual(["300"]);
  });

  it("reports a candidate without putting it in either write list", () => {
    const edited = COPY.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const plan = reconcileXPublished({ ...base, threads: [thread("400", [edited])], renderings: [rendering("x:1", COPY)] });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].rootId).toBe("400");
    expect(plan.candidates[0].itemId).toBe("x:1");
    expect(plan.confirmed).toEqual([]);
    // A candidate is NOT silently filed as external either — that would record it under a kr: id
    // and then a human confirming the match later would have two rows for one post.
    expect(plan.external).toEqual([]);
  });

  it("never confirms the same item twice in one run", () => {
    // Two live threads both matching one rendering: the second is a re-post or a near-duplicate, and
    // one item can only have one x-post row. The first (oldest) wins and the other is reported.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY]), thread("101", [COPY])],
      renderings: [rendering("x:1", COPY)],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.postId).toBe("100");
    expect(plan.candidates.map((c) => c.rootId)).toEqual(["101"]);
  });

  it("returns empty lists for no live threads rather than throwing", () => {
    const plan = reconcileXPublished({ ...base, threads: [], renderings: [rendering("x:1", COPY)] });
    expect(plan).toEqual({ confirmed: [], candidates: [], external: [], skipped: [] });
  });
});
