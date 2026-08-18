// tests/domain/translation/glossaryReview.test.ts
//
// The review file is the entire deliverable of `glossary:mine` — stdout and the Telegram notice are
// pointers to it. Its shape is not a design choice made in `glossaryReview.ts`: it reproduces the
// file a human actually filled in and applied on 2026-08-11 (`output/glossary-draft.json`, ten
// entries, all ten accepted). So the things pinned here are the things that made that file usable.
import { describe, it, expect } from "vitest";
import { renderCandidateReview, corpusSummary } from "../../../src/domain/translation/glossaryReview";
import type { CorpusStatus, MiningResult } from "../../../src/domain/translation/glossaryMining";

const FRESH: CorpusStatus = {
  state: "fresh",
  tweetCount: 118,
  coveredFrom: "2026-06-01T07:55:24.000Z",
  coveredTo: "2026-08-11T04:00:59.000Z",
  ageDays: 0,
};

const OPTS = {
  path: "/home/kyle/.herald/output/glossary/candidates-2026-08-17.json",
  now: "2026-08-17T06:53:00.000Z",
  sourceTweetCount: 523,
  translationCount: 14,
  reviewerEditCount: 6,
};

const RESULT: MiningResult = {
  corpus: FRESH,
  sentenceInitialOnly: 80,
  candidates: [
    {
      key: "RWA",
      signal: "proper-noun",
      tier: "A",
      term: "RWA",
      occurrences: 7,
      corpus: { ours: 24 },
      rule: "keep",
      note: "우리 원문 7회. 코퍼스에 원문 그대로 24회 — 원문 유지(keep)로 보입니다.",
      source: "0xMantleKR 코퍼스 원문 24회 (2026-06-01~2026-08-11)",
    },
    {
      key: "낸슨 → 난센",
      signal: "substitution",
      tier: "B",
      term: "난센",
      draft: "낸슨",
      published: "난센",
      sourceTerms: ["Nansen"],
      occurrences: 1,
      itemIds: ["x:2083206182484005059"],
      corpus: { ours: 0, theirs: 0 },
      rule: "transliterate",
      target: "난센",
      note: '초안 "낸슨" → 발행 "난센" · 1건.',
      source: "0xMantleKR 코퍼스 0:0 (2026-06-01~2026-08-11)",
    },
  ],
  rejected: [
    {
      key: "규모 → 사이즈",
      draft: "규모",
      published: "사이즈",
      itemIds: ["x:2081000000000000003"],
      corpus: { ours: 13, theirs: 0 },
      reason: '코퍼스 "규모" 13회 / "사이즈" 0회 — 그 교정은 1회성으로 보입니다.',
    },
  ],
};

const render = (result: MiningResult = RESULT): Record<string, unknown>[] =>
  renderCandidateReview(result, OPTS) as Record<string, unknown>[];

describe("renderCandidateReview", () => {
  it("survives a round trip through the JSON the CLI writes", () => {
    // The file is edited by a human in a text editor and never read back by this program, so the one
    // structural guarantee that matters is that what we write is valid JSON with no undefined holes
    // in it — `JSON.stringify` drops an undefined value silently, and a dropped `rule` reads as a
    // deliberate blank rather than as a bug.
    const text = JSON.stringify(render(), null, 2);
    expect(JSON.parse(text)).toEqual(render());
  });

  it("leads with the instructions, because nobody opening this file has read the source", () => {
    const header = render()[0];
    expect(header._사용법).toContain("pnpm glossary add");
    expect(header._신뢰도).toContain("A =");
    expect(header._근거).toContain("523");
    expect(header._생성).toContain(OPTS.path);
  });

  it("tells the reader how to make a candidate stop coming back", () => {
    // The load-bearing instruction. Without the dismissal list every candidate arrives again next
    // Monday and the Monday after, until the alert is noise people scroll past — which is exactly the
    // failure `translate:check --notify` was designed around when it refused to page on drift.
    const header = render()[0];
    expect(header._이건_아니다_싶으면).toContain("glossary-dismissed.json");
    expect(header._이건_아니다_싶으면).toContain("_후보");
  });

  it("gives every candidate the exact string the dismissal file wants", () => {
    // Silencing has to be a copy-paste. A human retyping `낸슨 → 난센` with the wrong arrow or a
    // double space writes a dismissal that silently matches nothing, and the only symptom is the
    // candidate returning — which reads as the dismissal file being broken.
    const entries = render().filter((e) => "_후보" in e);
    expect(entries.map((e) => e._후보)).toEqual(["RWA", "낸슨 → 난센"]);
  });

  it("warns that a substitution's term is Korean and must be swapped for the source term", () => {
    // The one thing a human could get wrong and not notice: `checkGlossary` matches `term` against
    // the ENGLISH source text, so a glossary entry whose term is 난센 matches nothing, forever, and
    // looks like a decision that was made.
    const header = render()[0];
    expect(header._term_주의).toContain("원문(영어) 표기");
    const nansen = render().find((e) => e._후보 === "낸슨 → 난센")!;
    expect(nansen._초안_발행).toBe("낸슨 → 난센");
    expect(nansen._원문_후보).toEqual(["Nansen"]);
    expect(nansen.target).toBe("난센");
  });

  it("carries the rejected candidates rather than dropping them", () => {
    // Two of these on the real run (`시장가`, `사이즈`) were the difference between a correct glossary
    // and a wrong one. Showing the work is what lets a human overrule it.
    const rejected = render().find((e) => "_기각" in e)!;
    expect(rejected._기각).toBe("규모 → 사이즈");
    expect(rejected._근거).toContain("13회");
    expect(JSON.stringify(render())).toContain("검토됨 · 기각");
  });

  it("says so plainly when there is nothing to decide", () => {
    const empty = render({ candidates: [], rejected: [], corpus: FRESH, sentenceInitialOnly: 0 });
    expect(empty).toHaveLength(2);
    expect(empty[1]._구간).toContain("이번 주 결정할 후보 없음");
  });

  it("says how many capitalized words the positional rule removed, and stays quiet at zero", () => {
    // The filter is the difference between the 170-line first fire and a 90-line one, so a reader
    // wondering why a term they expected is missing has to be able to see that something was removed
    // at all. A count rather than 80 more lines — and no line whatsoever on a week that removed
    // nothing, because a standing "0건" is the kind of noise that teaches people to skip the header.
    expect(String(render()[0]._근거)).toContain("80");
    const none = render({ ...RESULT, sentenceInitialOnly: 0 });
    expect(String(none[0]._근거)).not.toContain("줄·문장 첫머리");
    // ...and the sentence it does print says what was removed and how it comes back, not just a number.
    expect(String(render()[0]._근거)).toContain("문장 중간");
  });
});

describe("the substitution source label", () => {
  it("says which feed a substitution came from, so the reader knows how strong the evidence is", () => {
    const rows = renderCandidateReview(
      {
        candidates: [{
          key: "구매하신 → 구매한", signal: "substitution", tier: "A", term: "구매한",
          draft: "구매하신", published: "구매한", occurrences: 1, itemIds: ["x:1"], sources: ["review"],
        }],
        rejected: [],
        corpus: { state: "missing" },
      } as never,
      { path: "/tmp/c.json", now: "2026-08-18T00:00:00.000Z", sourceTweetCount: 0, translationCount: 0, reviewerEditCount: 1 },
    );
    expect(JSON.stringify(rows)).toContain("검수 수정");
  });
});

describe("the header's provenance sentence", () => {
  /**
   * The header used to name two inputs (source tweets, published translations) while stdout already
   * named three. A week whose only substitutions came from the reviewer feed would then print
   * "발행본이 있는 번역 0건에서 뽑았습니다" directly above a list of substitution candidates — a false
   * sentence, since a substitution plainly WAS found, just not from that feed.
   */
  it("names all three feeds, so a reviewer-only week isn't described as having found nothing", () => {
    const header = render({ ...RESULT, candidates: [], rejected: [] })[0];
    expect(header._근거).toContain(`${OPTS.reviewerEditCount}건`);
    expect(header._근거).toContain("검수");
    // The two feeds the header already named must still both be there.
    expect(header._근거).toContain(`${OPTS.sourceTweetCount}트윗`);
    expect(header._근거).toContain(`${OPTS.translationCount}건`);
  });
});

describe("the rejected row's source label", () => {
  /**
   * Without this, a rejection the reviewer made themselves (규모→사이즈, corpus 13:0) renders
   * identically to an anonymous downstream copyedit — the human can't tell it was their own call
   * being overruled, which is the one rejection most worth them revisiting.
   */
  it("says which feed produced a rejected pair, reusing the candidate rows' label", () => {
    const rows = renderCandidateReview(
      {
        candidates: [],
        rejected: [{
          key: "규모 → 사이즈", draft: "규모", published: "사이즈", itemIds: ["x:1"],
          sources: ["review"], corpus: { ours: 13, theirs: 0 },
          reason: '코퍼스 "규모" 13회 / "사이즈" 0회 — 그 교정은 1회성으로 보입니다.',
        }],
        corpus: { state: "missing" },
        sentenceInitialOnly: 0,
      } as never,
      { ...OPTS, reviewerEditCount: 1 },
    );
    expect(JSON.stringify(rows)).toContain("검수 수정");
  });
});

describe("corpusSummary", () => {
  it("names the collection window it graded against", () => {
    expect(corpusSummary(FRESH)).toContain("2026-06-01~2026-08-11");
    expect(corpusSummary(FRESH)).toContain("118트윗");
  });

  it("says why everything is B when the corpus is stale, missing or undated", () => {
    // Each of the three has to name `collect:reference`, because the reader of this file is the one
    // person who can fix it and nothing schedules that command by design.
    for (const corpus of [
      { ...FRESH, state: "stale", ageDays: 61 } as CorpusStatus,
      { state: "missing" } as CorpusStatus,
      { state: "undated", tweetCount: 118 } as CorpusStatus,
    ]) {
      const summary = corpusSummary(corpus);
      expect(summary, corpus.state).toContain("B");
      expect(summary, corpus.state).toContain("collect:reference");
    }
  });
});
