// tests/app/reconcileXPublished.test.ts
import { describe, it, expect } from "vitest";
import { isXCandidateRendering, reconcileXPublished, xMatchCandidates } from "../../src/app/ReconcileXPublished";
import { CANDIDATE_AT, TRANSLATION_MATCH_AT } from "../../src/domain/publish/xReconcile";
import { deliveryKey } from "../../src/domain/delivery/models";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { Translation } from "../../src/domain/translation/models";

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

function translation(itemId: string, koreanText: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId,
    source: "x",
    sourceText: "en",
    koreanText,
    status: "translated",
    translatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// A rewrite of COPY: the same post, edited the way a human edits it before posting. Scores well
// above TRANSLATION_MATCH_AT and nowhere near CONFIRMED_AT — which is the whole point.
const COPY_REWRITTEN =
  "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

// An unrelated post/translation pair, topically nothing like COPY (scores ~0.01 against it — well
// under CANDIDATE_AT, so a live thread carrying OTHER_REWRITTEN is `external` against COPY-based
// renderings, never a `candidate`), but OTHER_REWRITTEN scores ~0.83 against OTHER — well above
// TRANSLATION_MATCH_AT. Needed wherever a test must isolate the second pass's own guards from the
// first pass's candidate/confirmed banding, which COPY_REWRITTEN cannot do: it scores ~0.89 against
// COPY, which is itself inside the CANDIDATE_AT..CONFIRMED_AT band.
const OTHER = "이번주 커뮤니티 리워드 이벤트에 참여해주신 모든 분들께 진심으로 감사드립니다. 다음 라운드도 기대해주세요.";
const OTHER_REWRITTEN = "이번주 커뮤니티 리워드 이벤트에 참여해주신 모든 분들께 감사드립니다. 다음 라운드도 기대해주세요.";

const base = {
  deliveredKeys: new Set<string>(),
  historyIds: new Set<string>(),
  historyPostIds: new Set<string>(),
  handle: "0xMantleKR",
  translations: [] as Translation[],
};

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

  it("is exactly isXCandidateRendering, so no caller can spell the filter a second time", () => {
    // The predicate had three spellings and the loosest of them wrote a delivery row under a key
    // `send:channels` does not recognise. This asserts the composition, so a future edit to one and
    // not the other is a failing test rather than a duplicate live post.
    const all = [
      rendering("x:ok", COPY),
      rendering("x:draft", COPY, { status: "rendered" }),
      rendering("x:tg", COPY, { channel: "telegram" }),
      rendering("x:empty", ""),
    ];
    expect(xMatchCandidates(all).map((c) => c.itemId)).toEqual(all.filter(isXCandidateRendering).map((r) => r.itemId));
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

  it("takes the confirmed type from the x rendering even when a telegram one for the same item comes first", () => {
    // The defect this pins: `renderingByItemId` used to be built from the *full* renderings list and
    // take the first row matching the itemId — ignoring channel, status and text — so a same-item
    // telegram rendering ordered ahead of the x one handed its own `type` to the confirmed entry.
    // The written deliveryKey (x:1:announcement:x-post) is then not the one `SendChannels.run` gates
    // on (x:1:x:x-post), so the next `send:channels --target x` reads the item as unsent and posts
    // copy a human already published by hand — the single outcome this feature exists to prevent.
    // Order is not hypothetical: `PgFormattingStore.loadAll()` returns `order by ordinal`, i.e.
    // insertion order, and one translation routinely becomes several typed renderings with
    // DEFAULT_CHANNELS_BY_TYPE routing announcement/explainer/casual/kol to Telegram.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [
        rendering("x:1", COPY, { type: "announcement", channel: "telegram" }),
        rendering("x:1", COPY, { type: "x", channel: "x" }),
      ],
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.type).toBe("x");
    expect(deliveryKey(plan.confirmed[0].entry)).toBe("x:1:x:x-post");
  });

  it("ignores an unapproved same-item x rendering when taking the confirmed type", () => {
    // The other half of the same defect: a `status: "rendered"` x rendering is not something a human
    // signed off, so it is not eligible to be matched against — and it must not be eligible to hand
    // over a `type` either. The looser lookup took it whenever it came first.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY, { type: "kol", status: "rendered" }), rendering("x:1", COPY)],
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.confirmed).toHaveLength(1);
    expect(deliveryKey(plan.confirmed[0].entry)).toBe("x:1:x:x-post");
  });

  it("counts ambiguity off the eligible renderings, not the whole list", () => {
    // `itemIdOccurrences` and `renderingByItemId` must be built from the SAME filtered list, or the
    // guard reads 1 for a map that had a choice to make. Two *eligible* x renderings sharing the
    // itemId is ambiguous (the next test); an eligible one plus an ineligible telegram one is not,
    // and must still confirm rather than costing a human a pointless confirmation.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [
        rendering("x:1", COPY, { type: "casual", channel: "telegram" }),
        rendering("x:1", COPY, { type: "explainer", channel: "telegram" }),
        rendering("x:1", COPY),
      ],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(deliveryKey(plan.confirmed[0].entry)).toBe("x:1:x:x-post");
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
    expect(plan.candidates[0].reason).toBe("ambiguous-rendering-type");
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

  it("skips an external post whose postId is already in history under another itemId", () => {
    // The `history` tab's real identity for an X row is its postId (column D) — that is what
    // RecordImpressions filters and fetches on — not its itemId. `pnpm history:record --item x:…
    // --post-id …` is the documented manual path for a hand-posted thread, so the same live post
    // routinely already sits there under an `x:`-prefixed itemId. Keyed on `kr:<rootId>` alone, this
    // reconcile wrote a SECOND row for it, and impressions:record then measured the post into both.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("300", ["파이프라인과 무관한 한국팀 자체 공지입니다."])],
      renderings: [],
      historyPostIds: new Set(["300"]),
    });

    expect(plan.external).toEqual([]);
    expect(plan.skipped.map((s) => s.rootId)).toEqual(["300"]);
    expect(plan.skipped[0].reason).toMatch(/under a different itemId/);
  });

  it("still records an external post whose postId is not in history", () => {
    // The guard must not swallow the ordinary case: an unrelated postId sitting in the tab (a
    // telegram row's blank D, another post's id) leaves this thread writable.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("300", ["파이프라인과 무관한 한국팀 자체 공지입니다."])],
      renderings: [],
      historyPostIds: new Set(["999", ""]),
    });

    expect(plan.external.map((e) => e.record.itemId)).toEqual(["kr:300"]);
    expect(plan.skipped).toEqual([]);
  });

  it("reports a candidate without putting it in either write list", () => {
    const edited = COPY.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const plan = reconcileXPublished({ ...base, threads: [thread("400", [edited])], renderings: [rendering("x:1", COPY)] });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].rootId).toBe("400");
    expect(plan.candidates[0].itemId).toBe("x:1");
    expect(plan.candidates[0].reason).toBe("possible-match");
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
    expect(plan.candidates[0].reason).toBe("duplicate-live-thread");
  });

  it("skips a reply into someone else's thread instead of aborting the whole run", () => {
    // assembleThreads keys a thread on `conversationId || id`, and conversationId is the ROOT's id.
    // A reply the account made to another account's tweet therefore produces a thread whose root
    // belongs to an account fetchAuthoredTweets(handle) never returns — 85 of the 196
    // @Mantle_Official threads in the committed corpus have this shape, all one-tweet replies.
    // Before the guard, externalHistoryRecord threw inside plan building with no per-thread catch,
    // registerErrorHandler exited 1, and the timer reconciled nothing every six hours until the
    // reply aged past --since. It must not fall back to tweets[0] either: that would record another
    // account's tweet id as our postId behind an x.com/<handle>/status/<their-id> url that
    // impressions:record would then measure.
    const reply: AssembledThread = {
      rootId: "2075199257754169643", // a partner account's tweet — never in our own timeline
      tweets: [
        {
          id: "9999",
          conversationId: "2075199257754169643",
          text: "좋은 소식입니다. 함께 축하합니다.",
          createdAt: "2026-08-01T00:00:00.000Z",
          authorUserName: "0xMantleKR",
        } as SourceTweet,
      ],
    };

    const plan = reconcileXPublished({
      ...base,
      threads: [reply, thread("100", [COPY]), thread("200", ["파이프라인과 무관한 한국팀 자체 공지입니다."])],
      renderings: [rendering("x:1", COPY)],
    });

    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].rootId).toBe("2075199257754169643");
    // The reason names both causes the guard can't tell apart (see ReconcileXPublished.ts's guard
    // comment) — this test's own thread is the reply-into-another's-thread cause, but the string
    // must also point at the other one (root of ours outside --since) and its remedy, since a
    // human reading either shape gets the identical wording.
    expect(plan.skipped[0].reason).toMatch(/reply into someone else's thread/);
    expect(plan.skipped[0].reason).toMatch(/fell outside --since/);
    expect(plan.skipped[0].reason).toMatch(/re-run with a wider --since/);
    // The rest of the plan is still built around it — that is the whole point of skipping per thread.
    expect(plan.confirmed.map((c) => c.entry.postId)).toEqual(["100"]);
    expect(plan.external.map((e) => e.record.itemId)).toEqual(["kr:200"]);
  });

  it("returns empty lists for no live threads rather than throwing", () => {
    const plan = reconcileXPublished({ ...base, threads: [], renderings: [rendering("x:1", COPY)] });
    expect(plan).toEqual({ confirmed: [], candidates: [], external: [], skipped: [], posted: [], postedNearMisses: [] });
  });
});

describe("translations that already went out by hand", () => {
  it("retires a translation whose best live thread clears the threshold", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY_REWRITTEN])],
      renderings: [],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0]).toMatchObject({
      itemId: "x:1",
      rootId: "100",
      url: "https://x.com/0xMantleKR/status/100",
      postedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(plan.posted[0].score).toBeGreaterThanOrEqual(TRANSLATION_MATCH_AT);
  });

  it("leaves a translation below the threshold alone and writes nothing for it", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", ["전혀 관계없는 다른 주제의 게시물입니다. 오늘 날씨가 좋네요."])],
      renderings: [],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.posted).toEqual([]);
  });

  it("stays out of plan.posted when postedUrl is set AND its history row already exists — never scored, so `threads` is irrelevant", () => {
    // Genuinely done on both halves. `threads: []` deliberately: Phase A reads the rootId back out
    // of `postedUrl` itself (see rootIdFromPostUrl), never scores against live threads, so this
    // must hold even when the original thread is nowhere in this run's window at all.
    const plan = reconcileXPublished({
      ...base,
      threads: [],
      renderings: [],
      historyPostIds: new Set(["100"]),
      translations: [translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100" })],
    });
    expect(plan.posted).toEqual([]);
  });

  it("re-enters plan.posted when postedUrl is set but its history row is still missing, using the STORED postedAt — never re-scored", () => {
    // Task 4 review round 2, Concern 1: the retry must read the post already recorded, not
    // re-match against this run's live threads (which could silently pick a DIFFERENT thread if
    // the original one aged out of --since). `threads: []` proves the retry does not depend on the
    // original thread being present at all, and the stored `postedAt` (not a freshly scored
    // thread's `createdAt`) proves the value comes from the translation's own record.
    const plan = reconcileXPublished({
      ...base,
      threads: [],
      renderings: [],
      translations: [
        translation("x:1", COPY, {
          postedUrl: "https://x.com/0xMantleKR/status/100",
          postedAt: "2026-07-31T05:39:41.000Z",
          status: "posted",
        }),
      ],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0]).toMatchObject({
      itemId: "x:1",
      rootId: "100",
      url: "https://x.com/0xMantleKR/status/100",
      postedAt: "2026-07-31T05:39:41.000Z",
    });
  });

  it("a settled translation claims its thread even when genuinely done, so a DIFFERENT translation cannot be retired against the same post", () => {
    // Task 4 review round 2, Concern 2 — the dangerous one: without this claim, translation B
    // (which never actually went out) could be retired against thread T just because A (which
    // really did go out as T) happened to be genuinely done and skip without claiming. That would
    // silently remove B from a human's review queue forever while attributing T to two items.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [],
      historyPostIds: new Set(["100"]), // A's history row already exists — genuinely done
      translations: [
        translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100" }), // A, settled
        translation("x:2", COPY), // B — never posted, but would match thread 100 if it were free
      ],
    });
    expect(plan.posted).toEqual([]);
  });

  it("Phase A respects consumedRootIds: a thread already confirmed for a DIFFERENT item's rendering wins over a settled translation's own claim", () => {
    // Task 4 review round 3 — a gap round 2 introduced: Phase A only ever checked `claimedRootIds`
    // and `claimedItemIds` (the SAME-item case), never `consumedRootIds`. So a settled translation
    // (Y) whose stored rootId happened to equal a thread this run confirmed for a DIFFERENT item's
    // (X's) rendering could still enter plan.posted — one live post then gets both a delivery row
    // (X) and a history-retry row (Y). The rendering match is the stronger record: it carries a
    // real `type` and passed 2차 검수.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)], // confirms thread 100 for x:1 (X)
      translations: [
        // Y — settled against the SAME thread, missing its history row (historyPostIds is empty).
        translation("x:2", "이 번역은 무관합니다", {
          postedUrl: "https://x.com/0xMantleKR/status/100",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.itemId).toBe("x:1");
    expect(plan.posted).toEqual([]);
  });

  describe("a malformed postedUrl fails the run rather than silently skip", () => {
    // Task 4 review round 3: a silent `continue` past a malformed postedUrl would leave that
    // translation's own thread unclaimed, reopening the exact double-retire hole Concern 2 (round
    // 2) closed. `postedUrl` is written exclusively by `postUrl`/`RetireTranslation`, so every shape
    // below should be unreachable in correct operation — reaching it must fail loudly.
    const CASES: { label: string; postedUrl: string }[] = [
      { label: "a different account's post url", postedUrl: "https://x.com/SomeoneElse/status/100" },
      { label: "a tracking query string stuck to the id", postedUrl: "https://x.com/0xMantleKR/status/100?s=20" },
      { label: "a non-numeric id", postedUrl: "https://x.com/0xMantleKR/status/abc" },
      { label: "a bare trailing slash with no id at all", postedUrl: "https://x.com/0xMantleKR/status/" },
      // rootIdFromPostUrl alone WOULD extract "100" here (see that function's own test) — this case
      // exists to prove the round-trip check (postUrl(handle, rootId) === postedUrl), not just the
      // regex, is what actually guards Phase A: the trailing slash means the round trip does not
      // reproduce the original url byte-for-byte, so this must still fail rather than silently
      // accept a url that merely LOOKS parseable.
      { label: "digits followed by an extra trailing slash (round-trip mismatch)", postedUrl: "https://x.com/0xMantleKR/status/100/" },
    ];

    for (const { label, postedUrl } of CASES) {
      it(`throws for ${label}`, () => {
        expect(() =>
          reconcileXPublished({
            ...base,
            threads: [thread("100", [COPY])],
            renderings: [],
            translations: [translation("x:1", COPY, { postedUrl, postedAt: "2026-08-01T00:00:00.000Z" })],
          }),
        ).toThrow(/postedUrl/);
      });
    }
  });

  it("refuses to write a blank publishedAt when postedUrl is set but postedAt is missing", () => {
    // Should be unreachable — RetireTranslation always stamps postedAt alongside postedUrl in the
    // same upsert — but an unreachable case that becomes reachable must fail visibly rather than
    // write a blank `publishedAt` into the team's history sheet.
    expect(() =>
      reconcileXPublished({
        ...base,
        threads: [thread("100", [COPY])],
        renderings: [],
        translations: [translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100" })], // no postedAt, and historyPostIds is empty so this reaches the push
      }),
    ).toThrow(/postedAt/);
  });

  it("skips a translation whose item the rendering route confirmed in this run", () => {
    // The delivery row is the stronger record — it carries a real type and passed 2차 검수.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.posted).toEqual([]);
  });

  it("still skips that translation when a second, unrelated live thread would otherwise match it", () => {
    // Pins the `claimedItemIds` guard itself, not just the consumed-thread exclusion. The
    // single-thread version of this test above still passes if the guard is deleted, because the
    // consumed-thread exclusion alone (thread 100 is already `plan.confirmed`) is enough to leave
    // `plan.posted` empty. Thread 200 carries OTHER_REWRITTEN rather than COPY_REWRITTEN
    // deliberately: it must stay OUT of `plan.candidates` too (it scores ~0.01 against the x:1
    // rendering's COPY text, nowhere near CANDIDATE_AT), so that Finding 3's candidate-exclusion fix
    // cannot be the thing keeping this thread out of the second pass's pool — only the
    // `claimedItemIds` guard can. Without that guard, x:1 ends up both confirmed (rootId 100, the
    // stronger record) AND posted (rootId 200, via OTHER_REWRITTEN's ~0.83 score against
    // translation("x:1", OTHER)) — one item, two different posts backing it.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY]), thread("200", [OTHER_REWRITTEN])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:1", OTHER)],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.postId).toBe("100");
    expect(plan.posted).toEqual([]);
  });

  it("never reuses a thread already consumed by a confirmed rendering match", () => {
    // One live post must never become both a delivery row (for x:1) and a retire (for x:2).
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:2", COPY)],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.posted).toEqual([]);
  });

  it("never retires a thread that is already a candidate for a different item", () => {
    // Verified failure mode without this exclusion: `candidates: [{rootId: "400", itemId: "x:1", ...}]`
    // alongside `posted: x:2@400`. A human who later answers the candidate "yes, 400 is x:1" would
    // then find 400 already recorded as x:2's post, and x:2 — which never actually went out —
    // silently retired against it. The candidate's own score comfortably clears TRANSLATION_MATCH_AT
    // (it's within the CANDIDATE_AT..CONFIRMED_AT band, well above 0.25), so this thread genuinely
    // would have matched x:2's translation had it not already been claimed by the candidate verdict.
    const edited = COPY.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("400", [edited])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:2", COPY)],
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].rootId).toBe("400");
    expect(plan.candidates[0].itemId).toBe("x:1");
    expect(plan.posted).toEqual([]);
  });

  it("gives one thread to only one translation", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY_REWRITTEN])],
      renderings: [],
      translations: [translation("x:1", COPY), translation("x:2", COPY)],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0].itemId).toBe("x:1"); // first in input order wins, as claimedItemIds already does
  });

  it("ignores a rootless thread, which has no url or timestamp to stamp", () => {
    const rootless: AssembledThread = { rootId: "999", tweets: thread("100", [COPY]).tweets };
    const plan = reconcileXPublished({ ...base, threads: [rootless], renderings: [], translations: [translation("x:1", COPY)] });
    expect(plan.posted).toEqual([]);
  });

  it("removes a retired thread from plan.external instead of recording it twice", () => {
    // A hand-posted translation was never an approved rendering, so the first pass's `classify` had
    // no candidate to compare this thread against and correctly filed it as external (`kr:100`)
    // before this pass ever ran. Task 4 writes one history row per `plan.posted` entry the same way
    // it does per `plan.external` entry, so leaving both here would write two history rows for one
    // postId — exactly what the `historyPostIds` guard above exists to prevent across runs, just
    // reached from within this one run instead.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY_REWRITTEN])],
      renderings: [],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0].rootId).toBe("100");
    expect(plan.external).toEqual([]);
  });

  describe("plan.postedNearMisses", () => {
    // Shares just enough vocabulary with COPY (온체인/자산/시작) to score above 0 without
    // approaching TRANSLATION_MATCH_AT (0.25) — a real near-miss, not a match. Measured directly
    // against similarity() before use, not hand-tuned by eye.
    const NEAR_MISS_LIVE_TEXT = "온체인 자산이 시장에 올라오면 그 다음이 진짜 시작입니다 여러 팀들이 함께 준비하고 있으니 기대해주세요";
    const UNRELATED_LIVE_TEXT = "이번 주말 커뮤니티 밋업에서 만나요 다들 즐거운 하루 보내시고 편안한 저녁 시간 보내시길 바랍니다 감사합니다 여러분";

    it("reports a translation that scored above 0 but below TRANSLATION_MATCH_AT against its best thread", () => {
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("100", [NEAR_MISS_LIVE_TEXT])],
        renderings: [],
        translations: [translation("x:1", COPY)],
      });
      expect(plan.posted).toEqual([]);
      expect(plan.postedNearMisses).toHaveLength(1);
      expect(plan.postedNearMisses[0].itemId).toBe("x:1");
      expect(plan.postedNearMisses[0].rootId).toBe("100");
      expect(plan.postedNearMisses[0].score).toBeGreaterThan(0);
      expect(plan.postedNearMisses[0].score).toBeLessThan(TRANSLATION_MATCH_AT);
    });

    it("reports nothing for a thread that shares nothing at all (score 0)", () => {
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("100", [UNRELATED_LIVE_TEXT])],
        renderings: [],
        translations: [translation("x:1", COPY)],
      });
      expect(plan.postedNearMisses).toEqual([]);
    });

    it("never scores a settled translation (postedUrl set) — Phase A translations are read, not matched", () => {
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("100", [NEAR_MISS_LIVE_TEXT])],
        renderings: [],
        translations: [
          translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/999", postedAt: "2026-08-01T00:00:00.000Z" }),
        ],
      });
      expect(plan.postedNearMisses).toEqual([]);
    });

    it("excludes a thread a settled translation already claimed in Phase A (Concern 2's near-miss counterpart)", () => {
      // Thread 100 is genuinely done for x:1 (historyPostIds already has it) — Phase A still
      // claims it. x:2's best-scoring thread is the SAME one; without the claim it would show as a
      // near-miss against a thread that already belongs to a different, settled item.
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("100", [NEAR_MISS_LIVE_TEXT])],
        renderings: [],
        historyPostIds: new Set(["100"]),
        translations: [
          translation("x:1", "무관한 다른 번역 본문입니다", { postedUrl: "https://x.com/0xMantleKR/status/100" }),
          translation("x:2", COPY),
        ],
      });
      expect(plan.posted).toEqual([]);
      expect(plan.postedNearMisses).toEqual([]);
    });
  });
});
