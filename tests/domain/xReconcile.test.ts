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
  parsePostUrl,
  settledTranslationDisposition,
} from "../../src/domain/publish/xReconcile";
import type {
  SettledReleaseReason,
  SettledTranslationContext,
  SettledTranslationDisposition,
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

  describe("parsePostUrl", () => {
    it("inverts postUrl exactly, for any handle", () => {
      expect(parsePostUrl(postUrl("0xMantleKR", "2084128041543127356"))).toEqual({
        handle: "0xMantleKR",
        rootId: "2084128041543127356",
      });
      expect(parsePostUrl(postUrl("someoneElse", "99"))).toEqual({ handle: "someoneElse", rootId: "99" });
    });

    it("returns undefined, not a throw, for a url with no /status/<digits> at all", () => {
      // This function never throws — deciding what a malformed url means is the call site's job
      // (reconcileXPublished's Phase A now fails the run on one, rather than skip; see that
      // function's own doc comment for why a silent skip there is actively dangerous).
      expect(parsePostUrl("https://x.com/0xMantleKR")).toBeUndefined();
      expect(parsePostUrl("not a url at all")).toBeUndefined();
      expect(parsePostUrl("")).toBeUndefined();
      expect(parsePostUrl("https://x.com/0xMantleKR/status/")).toBeUndefined(); // no digits at all
    });

    it("captures only the digits, dropping a tracking query string stuck to the id (Task 4 review round 3)", () => {
      // The old `[^/]+` capture returned "123?s=20" whole — a postId impressions:record would then
      // try to measure verbatim. `(\d+)` stops at the first non-digit.
      expect(parsePostUrl("https://x.com/0xMantleKR/status/123?s=20")?.rootId).toBe("123");
      expect(parsePostUrl("https://x.com/0xMantleKR/status/123#reply")?.rootId).toBe("123");
      expect(parsePostUrl("https://x.com/0xMantleKR/status/123/")?.rootId).toBe("123");
    });

    it("returns undefined for a non-numeric id, rather than passing it straight through", () => {
      expect(parsePostUrl("https://x.com/0xMantleKR/status/abc")).toBeUndefined();
      expect(parsePostUrl("https://x.com/0xMantleKR/status/123abc")).toBeUndefined();
    });

    it("reports whose account the url names rather than judging it (Task 4 review round 4)", () => {
      // Deliberate: this function narrows a string to a candidate (handle, rootId) and says nothing
      // about whether that handle is the caller's own. Handing the handle BACK — rather than
      // silently folding "not our account" into "unparseable" — is what lets reconcileXPublished
      // tell a corrupt postedUrl (fail the run) apart from a well-formed one for a different
      // account (skip it), which before round 4 were one comparison and so one crash.
      expect(parsePostUrl("https://x.com/SomeoneElse/status/999")).toEqual({ handle: "SomeoneElse", rootId: "999" });
    });

    it("does not accept a lookalike host, so the round trip at the call site cannot be fooled by one", () => {
      // postUrl only ever builds https://x.com/... — a twitter.com url is not something this
      // codebase wrote, so it must not parse into a (handle, rootId) that looks like it was.
      expect(parsePostUrl("https://twitter.com/0xMantleKR/status/123")).toBeUndefined();
      expect(parsePostUrl("http://x.com/0xMantleKR/status/123")).toBeUndefined();
      expect(parsePostUrl("https://evil.example/x.com/0xMantleKR/status/123")).toBeUndefined();
    });
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

describe("settledTranslationDisposition", () => {
  // The table IS the point of this function's existence. Phase A of `reconcileXPublished` grew six
  // exits over four review rounds, and the correctness of every one of them turned on the same
  // question — does this exit leave a post unclaimed, and is that safe? — answered in prose, per
  // branch. Three of those rounds found a defect that was a wrong answer to it. Enumerating every
  // exit here, with the release invariant checked in one place inside the function, is what turns
  // "someone reasoned about this branch correctly" into something a test can hold.

  const URL = "https://x.com/0xMantleKR/status/100";
  // The account's OLD handle after a rename, or a typo in the stored url: a handle that is not this
  // run's, naming a post that really is in this run's pool. This is the shape that makes
  // "a foreign handle implies a different account, so its post can never collide with ours" false.
  const RENAMED_URL = "https://x.com/0xMantleKR_old/status/100";
  const POSTED_AT = "2026-07-31T05:39:41.000Z";

  function ctx(over: Partial<SettledTranslationContext> = {}): SettledTranslationContext {
    return {
      handle: "0xMantleKR",
      poolRootIds: new Set(),
      consumedRootIds: new Set(),
      claimedItemIds: new Set(),
      historyPostIds: new Set(),
      settledRootIds: new Set(),
      ...over,
    };
  }

  type Expected =
    | { kind: "phase-b" }
    | { kind: "claim"; rootId: string; retire: false }
    // A claim that writes nothing but resolved a conflict the caller must report. Split from the
    // plain `retire: false` shape above so a test cannot assert "claimed" and silently accept a
    // missing report — the whole safety argument for claiming instead of failing is that a person
    // still finds out.
    | { kind: "claim"; rootId: string; retire: false; reasonMatches: RegExp }
    | { kind: "claim"; rootId: string; retire: true; url: string; postedAt: string }
    | { kind: "release"; rootId: string; because: SettledReleaseReason; reasonMatches: RegExp }
    | { kind: "fail"; messageMatches: RegExp };

  const CASES: {
    label: string;
    translation: { itemId: string; postedUrl?: string; postedAt?: string };
    ctx: SettledTranslationContext;
    expected: Expected;
  }[] = [
    {
      label: "hands an unsettled translation to Phase B without looking at anything else",
      translation: { itemId: "x:1" },
      ctx: ctx({ poolRootIds: new Set(["100"]) }),
      expected: { kind: "phase-b" },
    },
    {
      label: "fails on a postedUrl that does not round-trip (a tracking query string)",
      // Not a release: a url this codebase did not write is unattributable, so there is no rootId to
      // test the invariant against and no honest way to leave it alone.
      translation: { itemId: "x:1", postedUrl: "https://x.com/0xMantleKR/status/100?s=20", postedAt: POSTED_AT },
      ctx: ctx(),
      expected: { kind: "fail", messageMatches: /postedUrl/ },
    },
    {
      label: "fails on a lookalike host, which parsePostUrl rejects outright",
      translation: { itemId: "x:1", postedUrl: "https://twitter.com/0xMantleKR/status/100", postedAt: POSTED_AT },
      ctx: ctx(),
      expected: { kind: "fail", messageMatches: /postedUrl/ },
    },
    {
      label: "releases an item the rendering route already confirmed, when its post is not in the pool",
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ claimedItemIds: new Set(["x:1"]), poolRootIds: new Set(["500"]) }),
      expected: { kind: "release", rootId: "100", because: "item-confirmed-elsewhere", reasonMatches: /x:1/ },
    },
    {
      label:
        "BUG 2 (reproduced): the same item is confirmed against a DIFFERENT thread while its own post IS in the pool — claims it, writing nothing, instead of releasing",
      // A rendering confirms x:1 against thread 200 while x:1.postedUrl names thread 100. Releasing
      // leaves 100 unclaimed, and the next translation that scores against it is retired against
      // x:1's real post. Nothing about the finished plan would show it: 200 and 100 are different
      // ids in different lists. Only this rule catches it.
      //
      // CHANGED by the final whole-branch review (Important 3), which is why this case reads
      // `claim` where round 5 asserted `fail`. Round 5's answer was right about the invariant and
      // wrong about the remedy: `x:reconcile` is an unattended six-hourly timer, so throwing here
      // reconciles NOTHING — not this item, not the other eight — on every tick until post 100 ages
      // out of a 30-day window or somebody hand-edits Postgres, and 되돌리기 keeps `postedUrl` so the
      // dashboard offers no way out either. A claim satisfies the same invariant more strongly (the
      // post leaves the pool outright, so no other translation can reach it), writes nothing at all,
      // and still reaches a person through the reported reason. The behaviour this case was written
      // to forbid — post 100 free for a different translation to be retired against — is exactly as
      // forbidden as it was.
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ claimedItemIds: new Set(["x:1"]), consumedRootIds: new Set(["200"]), poolRootIds: new Set(["100"]) }),
      expected: {
        kind: "claim",
        rootId: "100",
        retire: false,
        reasonMatches: /item-confirmed-elsewhere.*post 100 is still live in this run's pool/s,
      },
    },
    {
      label: "releases a post on another account, when that post is not in this run's pool",
      translation: { itemId: "x:1", postedUrl: RENAMED_URL, postedAt: POSTED_AT },
      ctx: ctx({ poolRootIds: new Set(["500"]) }),
      expected: { kind: "release", rootId: "100", because: "foreign-account", reasonMatches: /0xMantleKR_old/ },
    },
    {
      label:
        "BUG 1 (reproduced): a non-matching handle whose post IS in the pool — a rename or a typo — claims it, writing nothing, instead of releasing",
      // The round-4 assumption this kills: "a tweet id is globally unique, so a post recorded under
      // another handle can never be in this run's pool." An account rename (or a typo'd handle in a
      // url this codebase itself wrote) makes it this account's post under a handle that no longer
      // matches — and releasing it produced a plan naming post 100 in plan.skipped as foreign AND in
      // plan.posted as a different translation's retire.
      //
      // CHANGED by the final whole-branch review (Important 3) from `fail` to `claim`, for the
      // reason spelled out on the BUG 2 case above: on an unattended timer a throw is a permanent
      // total outage, and a claim forbids the same thing more strongly while writing nothing.
      translation: { itemId: "x:1", postedUrl: RENAMED_URL, postedAt: POSTED_AT },
      ctx: ctx({ poolRootIds: new Set(["100"]) }),
      expected: {
        kind: "claim",
        rootId: "100",
        retire: false,
        reasonMatches: /foreign-account.*post 100 is still live in this run's pool/s,
      },
    },
    {
      label: "claims, writing nothing, when an earlier settled translation already resolved this same post",
      // Two translations naming one live post. Before the final review this reached the caller's
      // post-condition and threw (`post 100 ... is also another plan.posted row`), taking the whole
      // unattended run down over hand-edited legacy data — the same class as BUG 1/BUG 2 above.
      // Claiming keeps the "one post, one row" guarantee (the second one writes nothing) and reports
      // the conflict instead.
      translation: { itemId: "x:2", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ settledRootIds: new Set(["100"]), poolRootIds: new Set(["100"]) }),
      expected: { kind: "claim", rootId: "100", retire: false, reasonMatches: /an earlier translation in this run/ },
    },
    {
      label: "releases a post a different item's rendering already consumed",
      translation: { itemId: "x:2", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ consumedRootIds: new Set(["100"]) }),
      expected: { kind: "release", rootId: "100", because: "already-consumed", reasonMatches: /two items claim one post/ },
    },
    {
      label: "releases an already-consumed post even if it is also listed in the pool",
      // The invariant's second clause, pinned on its own: a consumed post is already out of Phase B's
      // reach by a different mechanism, so releasing it cannot hand it to anyone. If `poolRootIds`
      // were ever computed as "all rooted threads" instead of "threads Phase B can still score",
      // this is the case that keeps the ordinary conflict report from turning into a crash.
      translation: { itemId: "x:2", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ consumedRootIds: new Set(["100"]), poolRootIds: new Set(["100"]) }),
      expected: { kind: "release", rootId: "100", because: "already-consumed", reasonMatches: /two items claim one post/ },
    },
    {
      label: "claims without retiring when the history row already exists — genuinely done, but the post is still ours",
      // The claim is the whole content of this exit: nothing is written, and the ONLY effect is that
      // a different translation cannot be retired against this post.
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ historyPostIds: new Set(["100"]), poolRootIds: new Set(["100"]) }),
      expected: { kind: "claim", rootId: "100", retire: false },
    },
    {
      label: "claims and retires when the history row is still owed, carrying the STORED url and postedAt",
      // Carried on the disposition rather than re-derived by the caller: the stored values are the
      // record, and a caller that rebuilt the url from its own handle would silently rewrite a
      // renamed account's history.
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ poolRootIds: new Set(["100"]) }),
      expected: { kind: "claim", rootId: "100", retire: true, url: URL, postedAt: POSTED_AT },
    },
    {
      label: "fails rather than retire with no postedAt, which would write a blank publishedAt",
      translation: { itemId: "x:1", postedUrl: URL },
      ctx: ctx(),
      expected: { kind: "fail", messageMatches: /postedAt/ },
    },
    {
      label: "treats a lowercased run handle as the SAME account and claims, since an X handle is case-insensitive",
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ handle: "0xmantlekr", poolRootIds: new Set(["100"]) }),
      expected: { kind: "claim", rootId: "100", retire: true, url: URL, postedAt: POSTED_AT },
    },
    {
      label: "treats an uppercased run handle as the SAME account and claims",
      translation: { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT },
      ctx: ctx({ handle: "0XMANTLEKR", historyPostIds: new Set(["100"]), poolRootIds: new Set(["100"]) }),
      expected: { kind: "claim", rootId: "100", retire: false },
    },
  ];

  for (const { label, translation, ctx: context, expected } of CASES) {
    it(label, () => {
      const got = settledTranslationDisposition(translation, context);

      if (expected.kind === "release") {
        if (got.kind !== "release") throw new Error(`expected a release, got ${got.kind}`);
        expect(got.rootId).toBe(expected.rootId);
        expect(got.because).toBe(expected.because);
        expect(got.reason).toMatch(expected.reasonMatches);
        return;
      }
      if (expected.kind === "fail") {
        if (got.kind !== "fail") throw new Error(`expected a fail, got ${got.kind}`);
        expect(got.message).toMatch(expected.messageMatches);
        return;
      }
      if (expected.kind === "claim" && "reasonMatches" in expected) {
        if (got.kind !== "claim") throw new Error(`expected a claim, got ${got.kind}`);
        expect(got.rootId).toBe(expected.rootId);
        expect(got.retire).toBe(false);
        // The report is half the fix: a claim that resolved a conflict silently would be the "silent
        // continue" this whole function exists to make impossible, just spelled differently.
        if (got.retire !== false) throw new Error("expected a non-retiring claim");
        expect(got.reason ?? "").toMatch(expected.reasonMatches);
        return;
      }
      expect(got).toEqual(expected);
    });
  }

  it("the table covers every outcome and every release reason — a new exit cannot be added untested", () => {
    // The guard on the guard. This function is only safer than the six-branch loop it replaced if
    // every exit is enumerated above; a seventh exit added without a case would leave exactly the
    // unexamined branch the whole refactor exists to prevent. Comparing against the declared unions
    // means widening the type without widening the table fails HERE, at the table, rather than in
    // production two rounds later.
    const ALL_KINDS: SettledTranslationDisposition["kind"][] = ["phase-b", "claim", "release", "fail"];
    const ALL_REASONS: SettledReleaseReason[] = ["item-confirmed-elsewhere", "already-consumed", "foreign-account"];

    const produced = CASES.map((c) => settledTranslationDisposition(c.translation, c.ctx));
    const releases = produced.filter((d): d is Extract<SettledTranslationDisposition, { kind: "release" }> => d.kind === "release");
    const claims = produced.filter((d): d is Extract<SettledTranslationDisposition, { kind: "claim" }> => d.kind === "claim");

    expect([...new Set(produced.map((d) => d.kind))].sort()).toEqual([...ALL_KINDS].sort());
    expect([...new Set(releases.map((d) => d.because))].sort()).toEqual([...ALL_REASONS].sort());
    // Both `claim` variants, not just whichever one happens to come first — and, within the
    // non-retiring one, both of ITS shapes: the plain no-op claim (nothing owed, nothing wrong) and
    // the conflict claim that must carry a reason for the caller to report. Those two are the same
    // TypeScript variant but opposite obligations on the caller, so covering only one would leave
    // the branch that replaced `fail` (see BUG 1 / BUG 2 above) untested by this guard.
    expect(claims.some((c) => c.retire)).toBe(true);
    expect(claims.some((c) => !c.retire && c.reason === undefined)).toBe(true);
    expect(claims.some((c) => !c.retire && c.reason !== undefined)).toBe(true);
  });

  it("is pure: the same inputs give the same disposition, and the context is never mutated", () => {
    const pool = new Set(["100"]);
    const consumed = new Set<string>();
    const claimed = new Set<string>();
    const history = new Set<string>();
    const settled = new Set<string>();
    const context = {
      handle: "0xMantleKR",
      poolRootIds: pool,
      consumedRootIds: consumed,
      claimedItemIds: claimed,
      historyPostIds: history,
      settledRootIds: settled,
    };
    const translation = { itemId: "x:1", postedUrl: URL, postedAt: POSTED_AT };

    const first = settledTranslationDisposition(translation, context);
    const second = settledTranslationDisposition(translation, context);
    expect(second).toEqual(first);
    expect([...pool]).toEqual(["100"]);
    expect([...consumed]).toEqual([]);
    expect([...claimed]).toEqual([]);
    expect([...history]).toEqual([]);
    expect([...settled]).toEqual([]);
  });
});
