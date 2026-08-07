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
    expect(plan).toEqual({
      confirmed: [],
      candidates: [],
      external: [],
      skipped: [],
      posted: [],
      postedNearMisses: [],
      captures: [],
    });
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
    // of `postedUrl` itself (see parsePostUrl), never scores against live threads, so this must hold
    // even when the original thread is nowhere in this run's window at all.
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

  it("reports that two-items-one-post conflict in plan.skipped instead of dropping it silently", () => {
    // Task 4 review round 4, Finding 2. The skip above is correct, but it emitted nothing at all —
    // not plan.posted, not postedNearMisses (a Phase A translation is never scored), not
    // plan.skipped. It fires on a genuine data conflict: one live post that an approved rendering
    // says is x:1 and a translation's own postedUrl says is x:2. Nothing about that self-heals — the
    // same conflict is re-derived and re-skipped every tick — so if the run says nothing, no one
    // ever fixes it. plan.skipped is the list that already means "left alone, and here is why", and
    // x-reconcile.ts prints every row of it with its reason.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      translations: [
        translation("x:2", "이 번역은 무관합니다", {
          postedUrl: "https://x.com/0xMantleKR/status/100",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });
    const conflict = plan.skipped.filter((s) => s.reason.includes("x:2"));
    expect(conflict).toHaveLength(1);
    expect(conflict[0].rootId).toBe("100");
    // Names both halves of the conflict — the item whose record was set aside and the post they are
    // contending for — because a row that only says "skipped" tells an operator nothing to act on.
    expect(conflict[0].reason).toMatch(/x:2/);
    expect(conflict[0].reason).toMatch(/100/);
  });

  describe("a malformed postedUrl fails the run rather than silently skip", () => {
    // Task 4 review round 3: a silent `continue` past a malformed postedUrl would leave that
    // translation's own thread unclaimed, reopening the exact double-retire hole Concern 2 (round
    // 2) closed. `postedUrl` is written exclusively by `postUrl`/`RetireTranslation`, so every shape
    // below should be unreachable in correct operation — reaching it must fail loudly.
    //
    // NOT in this list, since Task 4 review round 4: a well-formed url for a DIFFERENT account
    // ("https://x.com/SomeoneElse/status/100"). That is not corruption, and treating it as such made
    // every `--handle` run against another account a guaranteed crash — see the
    // "postedUrl for a different account" block below for what happens to it instead.
    const CASES: { label: string; postedUrl: string }[] = [
      { label: "a tracking query string stuck to the id", postedUrl: "https://x.com/0xMantleKR/status/100?s=20" },
      { label: "a non-numeric id", postedUrl: "https://x.com/0xMantleKR/status/abc" },
      { label: "a bare trailing slash with no id at all", postedUrl: "https://x.com/0xMantleKR/status/" },
      // parsePostUrl alone WOULD extract "100" here (see that function's own test) — this case
      // exists to prove the round-trip check (postUrl(parsed.handle, parsed.rootId) === postedUrl),
      // not just the regex, is what actually guards Phase A: the trailing slash means the round trip
      // does not reproduce the original url byte-for-byte, so this must still fail rather than
      // silently accept a url that merely LOOKS parseable.
      { label: "digits followed by an extra trailing slash (round-trip mismatch)", postedUrl: "https://x.com/0xMantleKR/status/100/" },
      // Corruption is corruption whoever the url names: a foreign handle only buys the SKIP path
      // when the url is otherwise byte-for-byte what postUrl builds. This one is not, so it throws
      // like any other malformed value — which is what stops round 4's fix from becoming a way to
      // launder a broken postedUrl past the guard by editing the handle in it.
      { label: "a different account's url that is ALSO malformed", postedUrl: "https://x.com/SomeoneElse/status/100?s=20" },
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

  describe("a postedUrl for a different account", () => {
    // Task 4 review round 4, Finding 1. `x-reconcile.ts` documents `--handle` as "point one run at a
    // different account without an env edit", and translations are filtered only by `source === "x"`
    // — never by handle, and they carry no handle field to filter by. So the moment one settled
    // @0xMantleKR translation exists, every run pointed anywhere else hit Phase A's round trip
    // against THIS run's handle and threw before printing a single line of plan. A well-formed url
    // for someone else's account is not corruption; it is simply not this run's business.
    const SETTLED_ELSEWHERE = { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" };

    it("skips it with a reason instead of throwing, so --handle against another account still runs", () => {
      const plan = reconcileXPublished({
        ...base,
        handle: "Mantle_Official",
        threads: [],
        renderings: [],
        translations: [translation("x:1", COPY, SETTLED_ELSEWHERE)],
      });
      expect(plan.posted).toEqual([]);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].rootId).toBe("100");
      expect(plan.skipped[0].reason).toMatch(/0xMantleKR/);
      expect(plan.skipped[0].reason).toMatch(/Mantle_Official/);
    });

    it("does not stop the rest of the run: a translation that IS this account's still gets retired", () => {
      // The crash's real cost was never the one foreign row — it was that nothing else in the run
      // got a chance. Thread 500 is @Mantle_Official's own live post and x:2 its translation; both
      // must survive the presence of x:1's foreign record.
      const plan = reconcileXPublished({
        ...base,
        handle: "Mantle_Official",
        threads: [thread("500", [OTHER_REWRITTEN])],
        renderings: [],
        translations: [translation("x:1", COPY, SETTLED_ELSEWHERE), translation("x:2", OTHER)],
      });
      expect(plan.posted).toHaveLength(1);
      expect(plan.posted[0]).toMatchObject({ itemId: "x:2", rootId: "500", url: "https://x.com/Mantle_Official/status/500" });
    });

    it("BUG 1 (round 5): claims rather than release a foreign post that is live in this run's pool — an account RENAME makes that collision real", () => {
      // This test replaces a round-4 test that asserted the opposite ("never claims a thread for the
      // foreign post — the skip really is a skip, not a silent claim"), on the same fixture. That
      // test's premise was that the rootId collision it constructs is one "reality forbids", because
      // a tweet id is globally unique and so a post recorded against another account can never be in
      // this run's pool. The premise is false in exactly two reachable ways, and both are ordinary:
      // the account was RENAMED (the id really is this account's post, under the handle it used to
      // have), or the handle in `postedUrl` is a typo. In either case the id IS in this run's pool,
      // and the round-4 behavior produced a plan that contradicted itself — post 100 reported in
      // plan.skipped as "not this run's account" AND in plan.posted as x:2's retire. Same plan, same
      // post, two lists, one of them attributing a real post to a translation that never went out.
      //
      // The release invariant (settledTranslationDisposition) is what closes it: a release is legal
      // only when its post is not something this run could hand to somebody else. The three OTHER
      // foreign-account tests in this block are untouched and still pass — a foreign post that is
      // genuinely absent from the pool (the overwhelmingly common case) is still released with a
      // reason.
      //
      // CHANGED by the final whole-branch review (Important 3): round 5 satisfied the invariant by
      // throwing, and this test asserted the throw. The invariant is unchanged and this fixture is
      // byte-for-byte the one round 5 wrote; only the remedy moved, because a throw is the wrong
      // remedy for THIS process. `x:reconcile` runs unattended every six hours, so a throw does not
      // refuse one item — it reconciles nothing at all, forever, until post 100 ages out of a 30-day
      // window (되돌리기 preserves postedUrl, so the dashboard offers no way out either). Claiming
      // the post removes it from Phase B's pool outright, which forbids the retire this test exists
      // to forbid *more* strongly than a release plus a throw did, writes nothing, and still puts
      // the conflict in front of a person via plan.skipped. Both halves are asserted below.
      const plan = reconcileXPublished({
        ...base,
        handle: "0xMantleKR",
        threads: [thread("100", [OTHER_REWRITTEN])],
        renderings: [],
        translations: [
          // The account's OLD handle: same account, same post, a url this codebase itself wrote
          // before the rename.
          translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR_old/status/100", postedAt: "2026-07-31T05:39:41.000Z" }),
          translation("x:2", OTHER), // would score ~0.83 against thread 100 and be retired against x:1's post
        ],
      });

      // The thing the bug produced: x:2 retired against x:1's real post. Still impossible.
      expect(plan.posted).toEqual([]);
      // And nothing was written for x:1 either — a claim is not a retire.
      expect(plan.postedNearMisses).toEqual([]);
      // Reported, not swallowed: this never self-heals, so a silent claim would be as invisible as
      // the silent release it replaced.
      const conflict = plan.skipped.filter((s) => s.rootId === "100");
      expect(conflict).toHaveLength(1);
      expect(conflict[0].reason).toMatch(/still live in this run's pool/);
      expect(conflict[0].reason).toMatch(/foreign-account/);
      expect(conflict[0].reason).toMatch(/x:1/);
    });

    it("treats a casing-only handle difference as the SAME account, claiming its thread rather than skipping", () => {
      // An X handle is case-insensitive, so `--handle 0xmantlekr` is the very same account the
      // stored url names — it is a spelling difference, not a different account. Skipping it would
      // leave thread 100 unclaimed and let x:2 (which never went out) be retired against x:1's post:
      // Concern 2, reopened through round 4's new skip path. x:1 here is genuinely done
      // (historyPostIds has 100), so the ONLY thing keeping plan.posted empty is the claim.
      const plan = reconcileXPublished({
        ...base,
        handle: "0xmantlekr",
        threads: [thread("100", [COPY])],
        renderings: [],
        historyPostIds: new Set(["100"]),
        translations: [
          translation("x:1", "무관한 다른 번역 본문입니다", { postedUrl: "https://x.com/0xMantleKR/status/100" }),
          translation("x:2", COPY),
        ],
      });
      expect(plan.posted).toEqual([]);
      // Thread 100 IS skipped by the first pass (historyPostIds already holds it, so its external
      // row would double-record the post) — that row is expected. What must NOT appear is a
      // foreign-account skip for x:1, which would mean Phase A treated 0xmantlekr and 0xMantleKR as
      // two accounts and left the thread unclaimed.
      expect(plan.skipped.filter((s) => /not this run's account/.test(s.reason))).toEqual([]);
    });

    it("still retires a casing-only handle difference whose history row is missing", () => {
      // The other half of the same rule: same account, so this is a real owed history row, not a
      // foreign record to leave alone.
      const plan = reconcileXPublished({
        ...base,
        handle: "0XMANTLEKR",
        threads: [],
        renderings: [],
        translations: [translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" })],
      });
      expect(plan.posted).toHaveLength(1);
      expect(plan.posted[0]).toMatchObject({ itemId: "x:1", rootId: "100", url: "https://x.com/0xMantleKR/status/100" });
    });
  });

  describe("the release invariant, end to end (round 5)", () => {
    // The unit-level table for these lives in tests/domain/xReconcile.test.ts
    // (settledTranslationDisposition). These two prove the rule reaches the plan a caller actually
    // writes from, through the real scoring pass — a disposition that is right in isolation and
    // wired up wrong would pass the table and fail here.

    it("BUG 2: claims rather than release a settled post whose item the rendering route confirmed against a DIFFERENT thread", () => {
      // Pre-existing since round 1, found by probe in round 4's review. x:1 is confirmed against
      // thread 200 by its approved rendering, so Phase A's claimedItemIds exit fired for x:1 — and
      // that exit released without ever looking at the post x:1's OWN postedUrl names. Thread 100 is
      // x:1's real post; nobody claimed it; x:2 (which never went out) scores against it and gets
      // retired against x:1's post. Note the two lists do NOT share a rootId here (confirmed 200,
      // posted 100), which is why the plan-level post-condition cannot catch this one — only the
      // release invariant can, and that is why the invariant lives in the disposition function
      // rather than in an after-the-fact check over the finished plan.
      //
      // CHANGED by the final whole-branch review (Important 3) from a `.toThrow` to the claim below.
      // Same fixture, same invariant, different remedy — see the BUG 1 test above for the full
      // reasoning (an unattended timer must not answer a two-defensible-records conflict by
      // reconciling nothing at all, every six hours, with no way out from the dashboard).
      const plan = reconcileXPublished({
        ...base,
        handle: "0xMantleKR",
        threads: [thread("200", [COPY]), thread("100", [OTHER_REWRITTEN])],
        renderings: [rendering("x:1", COPY)], // confirms thread 200 for x:1
        translations: [
          translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" }),
          translation("x:2", OTHER), // would be retired against 100 — x:1's real post
        ],
      });

      // The rest of the run still happens — the whole point of not throwing.
      expect(plan.confirmed.map((c) => c.entry.postId)).toEqual(["200"]);
      // x:2 is not retired against x:1's post, which is what BUG 2 was.
      expect(plan.posted).toEqual([]);
      const conflict = plan.skipped.filter((s) => s.rootId === "100");
      expect(conflict).toHaveLength(1);
      expect(conflict[0].reason).toMatch(/still live in this run's pool/);
      expect(conflict[0].reason).toMatch(/item-confirmed-elsewhere/);
    });

    it("reports — and does not throw over — two translations whose postedUrl names one live post", () => {
      // Parked at the end of Task 4 as "throws instead of writing two history rows: better
      // behaviour, reachable only from hand-edited legacy data", and re-opened by the final review
      // as the same class as BUG 1/BUG 2: on an unattended timer the throw is a permanent outage of
      // everything else, and "reachable only from hand-edited data" describes precisely the
      // situation nobody is watching for. Both translations are settled against post 100 with no
      // history row, so before this fix x:1 and x:2 each produced a plan.posted row for 100 and
      // assertOnePostOneRow refused the whole plan.
      //
      // First in input order acts; the second is claimed (writing nothing) and reported. The
      // one-post-one-row guarantee the throw was protecting is intact — it is now produced rather
      // than merely checked.
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("100", [COPY])],
        renderings: [],
        translations: [
          translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" }),
          translation("x:2", OTHER, { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" }),
        ],
      });

      expect(plan.posted.map((p) => p.itemId)).toEqual(["x:1"]);
      const conflict = plan.skipped.filter((s) => s.rootId === "100" && /x:2/.test(s.reason));
      expect(conflict).toHaveLength(1);
      expect(conflict[0].reason).toMatch(/an earlier translation in this run/);
    });

    it("still releases — and reports — a settled post that genuinely is not in this run's pool", () => {
      // The other half of the rule, and the reason it is scoped to the pool rather than being a
      // blanket "never release": the ordinary case (a post outside --since, on another account, or
      // already consumed) is still released with its reason, and the rest of the run proceeds. If
      // the invariant were "releases are illegal", this test is what would go red.
      const plan = reconcileXPublished({
        ...base,
        handle: "Mantle_Official",
        threads: [thread("500", [OTHER_REWRITTEN])],
        renderings: [],
        translations: [
          translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" }),
          translation("x:2", OTHER),
        ],
      });
      expect(plan.skipped.filter((s) => s.rootId === "100")).toHaveLength(1);
      expect(plan.posted.map((p) => p.rootId)).toEqual(["500"]);
    });
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

  describe("a post whose item ALREADY has an x-post delivery row", () => {
    // Final whole-branch review, Critical 1. The thread loop's `deliveredKeys` exit routed such a
    // thread to plan.skipped and `continue`d, claiming neither its rootId nor its itemId — the one
    // exit in either pass that took a live post out of the plan without taking it out of play. Both
    // directions below were reproduced against the pre-fix code, and the second one is not a corner
    // case: it is what the next tick does after any successful `send:channels --target x`.
    //
    // The plan-level post-condition cannot stand in for either of these. `assertOnePostOneRow`
    // deliberately excludes thread-loop skips, because for the OTHER skip reasons a rootId shared
    // with a retire is an ordinary outcome rather than a contradiction.
    const DELIVERED_KEY = deliveryKey({ itemId: "x:1", type: "x", outletId: "x-post" });

    it("does not hand it to an UNRELATED translation as a retire", () => {
      // Thread 333 is an exact paste of x:1's approved rendering and x:1's delivery row already
      // exists. x:2 is a different translation whose text rewrites the same copy, so it scores
      // ~0.89 against thread 333 — well over TRANSLATION_MATCH_AT. Before the fix this produced
      // `posted: [{ itemId: "x:2", rootId: "333" }]`, i.e. an `x:x:2` publish-history row carrying a
      // postId that already carries an `x-post` delivery row for x:1 — and `impressions:record`
      // (which filters `channel === "x" && postId`) then measures the one live post into both.
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("333", [COPY])],
        renderings: [rendering("x:1", COPY)],
        deliveredKeys: new Set([DELIVERED_KEY]),
        translations: [translation("x:2", COPY_REWRITTEN)],
      });

      expect(plan.posted).toEqual([]);
      expect(plan.postedNearMisses).toEqual([]);
      // The skip itself is unchanged — this is still a no-op for the rendering route, not new work.
      expect(plan.skipped.map((s) => s.rootId)).toEqual(["333"]);
      expect(plan.confirmed).toEqual([]);
    });

    it("does not flip its OWN translation to posted — the guaranteed next tick after send:channels", () => {
      // The steady state, not an edge: send:channels posts x:1's approved rendering, writing the
      // delivery row. Six hours later the live post IS x:1's own copy, so Phase B scored the item's
      // translation ~0.89 against it and retired the translation the item was already sent from —
      // silently moving it out of 1차 검수 to a terminal status, on the most ordinary send there is.
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("333", [COPY])],
        renderings: [rendering("x:1", COPY)],
        deliveredKeys: new Set([DELIVERED_KEY]),
        translations: [translation("x:1", COPY_REWRITTEN)],
      });

      expect(plan.posted).toEqual([]);
    });

    it("keeps its item out of Phase B even when a SECOND live thread would match that item's translation", () => {
      // Pins the `claimedItemIds` half on its own. The two tests above still pass if only the rootId
      // is consumed, because thread 333 leaving the pool is enough. Here thread 444 is a different
      // live post that matches x:1's translation text (~0.83) and is nowhere near x:1's rendering
      // (~0.01 against COPY, so it stays external rather than becoming a candidate — Finding 3's
      // candidate-exclusion cannot be what saves this). x:1 already has a delivery row for post 333;
      // retiring its translation against post 444 would put one item behind two different live
      // posts, with a history row and a delivery row disagreeing about which one it is.
      //
      // This mirrors, for the pre-existing-delivery-row case, the test the fresh-confirmation case
      // already has ("still skips that translation when a second, unrelated live thread would
      // otherwise match it") — the two exits must consume identically, which is the whole fix.
      const plan = reconcileXPublished({
        ...base,
        threads: [thread("333", [COPY]), thread("444", [OTHER_REWRITTEN])],
        renderings: [rendering("x:1", COPY)],
        deliveredKeys: new Set([DELIVERED_KEY]),
        translations: [translation("x:1", OTHER)],
      });

      expect(plan.posted).toEqual([]);
      expect(plan.postedNearMisses).toEqual([]);
    });
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

describe("published text capture", () => {
  it("captures a freshly retired translation", () => {
    // The Phase B path: our draft matched a hand-posted thread this run.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("999", ["가장 최근에 구매한 토큰화 자산은 무엇인가요?"])],
      renderings: [],
      translations: [translation("x:1", "가장 최근에 구매하신 토큰화 자산은 무엇입니까?")],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.captures).toEqual([{ itemId: "x:1", rootId: "999", text: "가장 최근에 구매한 토큰화 자산은 무엇인가요?" }]);
  });

  // THE regression guard for this feature. xReconcile.ts:427 returns `retire: false` for a settled
  // translation whose post already carries a history row — it never re-enters plan.posted. All 14
  // translations retired on 2026-08-07 are in exactly that state, so a capture hanging off the
  // retire path would back-fill none of them, silently, forever.
  it("captures a settled translation whose post already has a history row and is NOT re-retired", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("999", ["올라간 글"])],
      renderings: [],
      translations: [
        translation("x:1", "무관한 원문", {
          status: "posted",
          postedUrl: "https://x.com/0xMantleKR/status/999",
          postedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      historyPostIds: new Set(["999"]), // history already written -> retire: false
    });
    expect(plan.posted).toEqual([]); // proves the retire path would have missed it
    expect(plan.captures).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("captures nothing when every settled row already has its published text", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("999", ["올라간 글"])],
      renderings: [],
      translations: [
        translation("x:1", "무관한 원문", {
          status: "posted",
          postedUrl: "https://x.com/0xMantleKR/status/999",
          postedAt: "2026-08-01T00:00:00.000Z",
          publishedText: "이미 있음",
        }),
      ],
      historyPostIds: new Set(["999"]),
    });
    expect(plan.captures).toEqual([]);
  });
});
