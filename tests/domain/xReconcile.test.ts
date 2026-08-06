// tests/domain/xReconcile.test.ts
import { describe, it, expect } from "vitest";
import {
  CONFIRMED_AT,
  CANDIDATE_AT,
  classify,
  findRootTweet,
  threadText,
  externalHistoryRecord,
  observedDelivery,
  postUrl,
} from "../../src/domain/publish/xReconcile";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tweet(id: string, text: string, createdAt: string): SourceTweet {
  return {
    id,
    conversationId: id,
    text,
    createdAt,
    authorUserName: "0xMantleKR",
  } as SourceTweet;
}

function thread(rootId: string, texts: string[], createdAt = "2026-08-01T00:00:00.000Z"): AssembledThread {
  return { rootId, tweets: texts.map((t, i) => tweet(i === 0 ? rootId : `${rootId}${i}`, t, createdAt)) };
}

const APPROVED = "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 완전한 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

describe("classify", () => {
  it("confirms an exact copy-paste", () => {
    // The whole point: Kyle pastes approved copy by hand, so the live text is the approved text.
    const v = classify(thread("1", [APPROVED]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("confirmed");
    expect(v.score).toBeGreaterThanOrEqual(CONFIRMED_AT);
    if (v.kind === "confirmed") expect(v.itemId).toBe("x:1");
  });

  it("calls an unrelated post external, even at the KOL matcher's threshold", () => {
    // Measured 2026-08-06: an unrelated @0xMantleKR post scored 0.350 against one of our renderings
    // — above MATCH_THRESHOLD = 0.3. Recording a delivery on that evidence would have written an
    // irreversible `sent` row for a post that is not ours. It must land in external, not candidate:
    // it is not ours, so it must not cost a human a confirmation either.
    const unrelated = "맨틀 한국 스쿼드에서 새로운 멤버를 찾습니다. 콘텐츠와 커뮤니티 활동을 통해 맨틀의 RWA 생태계를 알리는 일입니다.";
    const v = classify(thread("2", [unrelated]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("external");
    expect(v.score).toBeLessThan(CANDIDATE_AT);
  });

  it("is external when there are no candidates at all", () => {
    // The normal case: the pipeline has produced 3 x renderings ever against 47 live posts.
    const v = classify(thread("3", ["아무 관계 없는 글"]), []);
    expect(v.kind).toBe("external");
    expect(v.score).toBe(0);
  });

  it("reports a near-but-edited paste as a candidate rather than confirming it", () => {
    // A human pasted and then tweaked a sentence. Real, and exactly the band a person must judge:
    // writing `sent` on a guess is unrecoverable, so the middle band is reported and not written.
    const edited = APPROVED.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const v = classify(thread("4", [edited]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("candidate");
    expect(v.score).toBeGreaterThanOrEqual(CANDIDATE_AT);
    expect(v.score).toBeLessThan(CONFIRMED_AT);
  });

  it("carries the real score on a near-miss, not a hard-coded zero", () => {
    // The other "external" cases above reach `score: 0` two different ways — no candidates at all
    // (classify's own short-circuit) and a real comparison that shares no 3-gram. Neither exercises
    // the branch that bands a real, non-zero score below CANDIDATE_AT. This fixture — a 40-character
    // prefix of APPROVED — scores 0.46774193548387094 against it: below CANDIDATE_AT (0.5) so the
    // verdict is still external, but comfortably non-zero, and that is what lets the CLI report a
    // near-miss instead of a flat 0 for every non-match.
    //
    // `classify` does NOT call `bestMatch`, and this test is one of the two reasons why: bestMatch
    // discards anything under MATCH_THRESHOLD (0.3) and returns undefined, which would collapse the
    // sub-0.3 case in the next test back onto "nothing to compare against".
    const nearMiss = APPROVED.slice(0, 40);
    const v = classify(thread("7", [nearMiss]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("external");
    expect(v.score).toBeGreaterThan(0);
    expect(v.score).toBeLessThan(CANDIDATE_AT);
  });

  it("picks the best candidate, not merely a passing one", () => {
    const other = "완전히 다른 주제의 승인된 원고입니다. 여기에는 겹치는 문장이 없습니다.";
    const v = classify(thread("5", [APPROVED]), [
      { itemId: "x:other", text: other },
      { itemId: "x:right", text: APPROVED },
    ]);
    expect(v.kind).toBe("confirmed");
    if (v.kind === "confirmed") expect(v.itemId).toBe("x:right");
  });

  it("reports a real score below MATCH_THRESHOLD instead of collapsing it to 0", () => {
    // classify must NOT delegate to bestMatch: bestMatch throws away any score under
    // MATCH_THRESHOLD (0.3) and returns undefined, which is right for the KOL matcher's own
    // "suggestion, never authoritative" use but wrong here — a live thread that scored something
    // real, just low, is different from a thread with no approved copy to compare against at all,
    // and a human reading `x:reconcile`'s near-miss list needs that difference. Measured shape: a
    // real @0xMantleKR thread once scored 0.2598 against a planted approved rendering and was
    // reported as scored-0 before this fix — indistinguishable from "nothing to compare against".
    // This fixture — a 25-character prefix of APPROVED — reproduces that shape: 0.2903225806451613,
    // below MATCH_THRESHOLD but real and non-zero.
    const shortPrefix = APPROVED.slice(0, 25);
    const v = classify(thread("8", [shortPrefix]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("external");
    expect(v.score).toBeGreaterThan(0);
    expect(v.score).toBeLessThan(0.3);
  });

  it("resolves an exact score tie to the first candidate in input order", () => {
    // Mirrors bestMatch's own tie-break convention (attribution.ts: only `score > best.score`
    // replaces the leader), which ReconcileXPublished.ts's renderingByItemId relies on classify
    // preserving. Both candidates carry the identical APPROVED text, so both score identically —
    // the only thing that can decide the winner is input order.
    const v = classify(thread("9", [APPROVED]), [
      { itemId: "x:first", text: APPROVED },
      { itemId: "x:second", text: APPROVED },
    ]);
    expect(v.kind).toBe("confirmed");
    if (v.kind === "confirmed") expect(v.itemId).toBe("x:first");
  });
});

describe("threadText", () => {
  it("joins a thread's tweets in order, so a thread matches copy written as one piece", () => {
    // Real threads on the account run root + up to six replies. The approved rendering is one
    // block of text, so matching a reply on its own would score every thread as external.
    const t = thread("6", ["첫 문장입니다.", "이어지는 문장입니다.", "마지막 문장입니다."]);
    const text = threadText(t);
    expect(text).toContain("첫 문장입니다.");
    expect(text).toContain("이어지는 문장입니다.");
    expect(text).toContain("마지막 문장입니다.");
    expect(text.indexOf("첫")).toBeLessThan(text.indexOf("마지막"));
  });
});

describe("record shapes", () => {
  const t = thread("2084128041543127356", ["당첨자 발표", "첫 번째", "두 번째"], "2026-08-03T04:03:40.000Z");

  it("gives an external post a kr: id, never an x: one", () => {
    // src/adapters/content/xArticleMeta.ts short-circuits on ids that do not start with "x:", and
    // that short-circuit is the protection: a kr: id can never trigger a lookup for a source post
    // that does not exist.
    const r = externalHistoryRecord(t, "0xMantleKR");
    expect(r.itemId).toBe("kr:2084128041543127356");
    expect(r.itemId.startsWith("x:")).toBe(false);
  });

  it("records one row for a whole thread, keyed on the root", () => {
    const r = externalHistoryRecord(t, "0xMantleKR");
    expect(r.postId).toBe("2084128041543127356");
    expect(r.publishedAt).toBe("2026-08-03T04:03:40.000Z");
    expect(r.channel).toBe("x");
    expect(r.outletId).toBe("x-post");
    expect(r.url).toBe("https://x.com/0xMantleKR/status/2084128041543127356");
  });

  it("writes a confirmed match as an observation, not as a human's claim", () => {
    // models.ts:5-6 — `sent` is an observation and is never reversed; `delivered` is a claim a human
    // can untick. A post read back off X with an id and a url is the observation.
    const e = observedDelivery("x:1", "x", t, "0xMantleKR");
    expect(e.status).toBe("sent");
    expect(e.itemId).toBe("x:1");
    expect(e.type).toBe("x");
    expect(e.outletId).toBe("x-post");
    expect(e.postId).toBe("2084128041543127356");
    expect(e.url).toBe("https://x.com/0xMantleKR/status/2084128041543127356");
    expect(e.at).toBe("2026-08-03T04:03:40.000Z");
    // A human pasted it, so the delivery was manual even though a machine noticed.
    expect(e.by).toBe("manual");
  });

  it("builds urls from the handle it is given, not a hardcoded account", () => {
    expect(postUrl("someoneElse", "99")).toBe("https://x.com/someoneElse/status/99");
  });

  it("answers findRootTweet with undefined for a reply into someone else's thread", () => {
    // The shape callers walking many threads must test BEFORE building a record: a rootless thread
    // is a reply the account made into another account's thread, which is common (85 of the 196
    // @Mantle_Official threads in the committed corpus), not a bug. `reconcileXPublished` asks this
    // question and skips; only a hand-built thread should ever reach the throw below.
    const reply: AssembledThread = {
      rootId: "2075199257754169643",
      tweets: [tweet("9999", "좋은 소식입니다.", "2026-08-01T00:00:00.000Z")],
    };
    expect(findRootTweet(reply)).toBeUndefined();
    expect(findRootTweet(t)?.id).toBe("2084128041543127356");
  });

  it("throws rather than guess a publishedAt/postId when the root tweet is missing", () => {
    // externalHistoryRecord and observedDelivery both derive publishedAt/postId from the tweet
    // whose id equals rootId, not from tweets[0]. If that tweet is absent, falling back to
    // tweets[0] would silently record the wrong timestamp for a thread assembled out of order or
    // missing its root — a bug worth failing loudly on, not guessing past. Build a thread whose
    // rootId names a tweet that plain does not exist in `tweets`.
    const orphan: AssembledThread = {
      rootId: "missing-root",
      tweets: [tweet("not-the-root", "당첨자 발표", "2026-08-03T04:03:40.000Z")],
    };
    expect(() => externalHistoryRecord(orphan, "0xMantleKR")).toThrow("missing-root");
    expect(() => observedDelivery("x:1", "x", orphan, "0xMantleKR")).toThrow("missing-root");
  });
});
