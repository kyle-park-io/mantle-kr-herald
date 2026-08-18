// tests/domain/translation/glossaryMining.test.ts
//
// The thresholds in `glossaryMining.ts` were MEASURED, not chosen — every one of them comes off a
// hand-run against production on 2026-08-11 whose ten proposals were all accepted (glossary 96 → 106)
// and whose two rejections were the difference between a correct glossary and a wrong one. A measured
// constant with no failing test is a number the next person edits freely, so each one is pinned here
// against the case that produced it, and each is mutation-checked from the other side: the test also
// states the value that would break it.
//
// The fixtures are shaped like the real data (Korean sentences with a one-word edit; a corpus of
// @0xMantleKR tweets carrying @handles and t.co links) rather than minimal, because two of the rules
// here — the mention strip and the rejection rule — exist entirely because real data has a texture
// that a minimal fixture does not.
import { describe, it, expect } from "vitest";
import {
  countProse,
  gradeCorpus,
  mineGlossaryCandidates,
  properNounOccurrences,
  properNounRuns,
  proseText,
  sentenceSimilarity,
  substitutionEdits,
  tierFor,
  MAX_DIFF_WORDS,
  MIN_PROPER_NOUN_OCCURRENCES,
  REFERENCE_STALE_AFTER_DAYS,
  REJECT_MIN_OURS,
  SENTENCE_MATCH_MAX,
  SENTENCE_MATCH_MIN,
  TIER_A_MIN_CORPUS,
  type CorpusStatus,
  type GlossaryCandidate,
  type MinedTranslation,
  type MiningInput,
} from "../../../src/domain/translation/glossaryMining";
import type { GlossaryEntry } from "../../../src/domain/translation/models";
import type { TextPair } from "../../../src/domain/lineage/humanEdits";

const NOW = "2026-08-11T12:00:00.000Z";

const entry = (term: string, rule: GlossaryEntry["rule"], target?: string): GlossaryEntry => ({
  term,
  rule,
  target,
  updatedAt: "2026-08-01",
});

/** A glossary with something in it, so the module is never exercised against the empty case the CLI refuses. */
const GLOSSARY: GlossaryEntry[] = [
  entry("Mantle", "keep"),
  entry("real-world assets", "translate", "실물자산(RWA)"),
  entry("narrative", "transliterate", "내러티브"),
];

const repeat = (line: string, times: number): string[] => Array.from({ length: times }, () => line);

/**
 * A reference corpus with the counts actually measured against `output/x/reference/items.json`
 * (85 threads / 118 tweets, 2026-06-01 ~ 2026-08-11) for every term this file reasons about:
 *
 *   RWA 24 · Atomic RFQ 12 · IPO 8 · CCIP 6 · AMM 4 · Mentor Clinic 0 · World Cup 0
 *   Turing Test 9 : 튜링 테스트 5   ·   시장 가격 2 : 시장가 0   ·   규모 13 : 사이즈 0
 *   Nansen 0 in prose, 6 raw hits — all of them `@nansen_ai` or an x.com link
 */
const CORPUS_TWEETS: string[] = [
  ...repeat("RWA 거래가 24시간 이어졌습니다", 24),
  ...repeat("모든 주문은 Atomic RFQ의 확정 호가로 체결됩니다", 12),
  ...repeat("사상 최대 IPO의 토큰화 주식", 8),
  ...repeat("모든 구간을 CCIP가 보호합니다", 6),
  ...repeat("AMM 또는 Atomic RFQ를 통해 거래되며", 4),
  ...repeat("맨틀 튜링 테스트 해커톤이 진행 중입니다", 5),
  ...repeat("Turing Test 신청 링크는 아래에 있습니다", 9),
  ...repeat("현재 시장 가격 기준으로 계산했습니다", 2),
  ...repeat("포지션 규모 제한을 확인하세요", 13),
  // The mention/URL texture the strip exists for. Six hits of `nansen`, none of them prose.
  "@nansen_ai의 맨틀 Q1 리포트: 총 660만 건의 트랜잭션 기록",
  "→ 후원사: @Elfa_AI, @SurfAI, @nansen_ai",
  "@nansen_ai의 Q2 리포트가 그 전체 그림을 보여줍니다",
  "@elfa_ai, @nansen_ai, @caladanxyz와 함께 빌더스 나이트를 열었습니다",
  "@elfa_ai, @OrbitAI_OAI, @nansen_ai는 참가자들에게 무료 API 크레딧을 제공했습니다",
  "https://x.com/nansen_ai/status/2080594345774961004",
];

const CORPUS_RUNS = [{ covered: { from: "2026-06-01T07:55:24.000Z", to: "2026-08-11T04:00:59.000Z" } }];

/** The four real edits, each as a draft/published sentence pair a human actually made. */
const TRANSLATIONS: MinedTranslation[] = [
  {
    itemId: "x:2083206182484005059",
    sourceText: "Nansen's Q2 report on Mantle is out. Read the numbers behind the growth.",
    koreanText: "낸슨 리포트가 맨틀의 성장 숫자를 그대로 보여줍니다",
    publishedText: "난센 리포트가 맨틀의 성장 숫자를 그대로 보여줍니다",
  },
  {
    itemId: "x:2081000000000000001",
    sourceText: "Applications for the Mantle Turing Test hackathon are open.",
    koreanText: "맨틀 Turing Test 해커톤 참가 신청이 열렸습니다",
    publishedText: "맨틀 튜링 테스트 해커톤 참가 신청이 열렸습니다",
  },
  {
    itemId: "x:2081000000000000002",
    sourceText: "Tokenized equities settle against live market prices.",
    koreanText: "토큰화 주식은 현재 시장 가격 기준으로 정산됩니다",
    publishedText: "토큰화 주식은 현재 시장가 기준으로 정산됩니다",
  },
  {
    itemId: "x:2081000000000000003",
    sourceText: "Check the position size limit before you trade.",
    koreanText: "거래 전에 포지션 규모 제한을 확인하세요",
    publishedText: "거래 전에 포지션 사이즈 제한을 확인하세요",
  },
];

/**
 * English source tweets, at the frequencies the sweep measured across ~523 collected tweets — and,
 * since 2026-08-12, in the POSITIONS the real corpus puts them in.
 *
 * Position is now a signal, so a fixture where every term opens its line would exercise the opposite
 * of the real data. Both shapes here are measured off the 525-tweet production corpus:
 *
 * - `RWA` and `AMM` open a line most times they appear ("RWA volume keeps climbing…") and sit inside
 *   a clause some of the time ("Mantle leads every L2 in RWA capital deployed…", "…through Atomic RFQ
 *   and AMM."). Real hits, quoted almost verbatim.
 * - `Together` and `Tomorrow` are two of the 110 words that only ever opened a line on the first real
 *   run. They are here so the filter has something real to remove; without them the drop count below
 *   would be zero and every assertion about it would pass vacuously.
 */
const SOURCE_TWEETS: string[] = [
  ...repeat("RWA volume keeps climbing on Mantle.", 5),
  ...repeat("Mantle leads every L2 in RWA capital deployed onchain.", 2),
  ...repeat("Every order fills at an Atomic RFQ firm quote.", 5),
  ...repeat("AMM or Atomic RFQ, your choice.", 2),
  ...repeat("Trade it 24/7 through Atomic RFQ and AMM.", 2),
  ...repeat("Join the Mentor Clinic this week.", 3),
  ...repeat("The Turing Test hackathon is live.", 3),
  "A single Fluxion mention that should never become a candidate.",
  ...repeat("Together we ship.", 3),
  ...repeat("Tomorrow we open registrations.", 3),
];

const input = (over: Partial<MiningInput> = {}): MiningInput => ({
  sourceTweets: SOURCE_TWEETS,
  translations: TRANSLATIONS,
  glossary: GLOSSARY,
  dismissed: [],
  corpusTweets: CORPUS_TWEETS,
  corpusRuns: CORPUS_RUNS,
  now: NOW,
  ...over,
});

const byKey = (result: { candidates: GlossaryCandidate[] }, key: string): GlossaryCandidate | undefined =>
  result.candidates.find((c) => c.key === key);

// ── the corpus counter ───────────────────────────────────────────────────────────────────────────

describe("countProse", () => {
  it("does not count a term that only ever appears inside an @handle or a link", () => {
    // The single most important line in the module, measured: `Nansen` matches six times in the real
    // corpus with word boundaries and case folding, and every one of them is `@nansen_ai` or an
    // x.com URL. Counting those would have graded the run's best find — the human's 낸슨 → 난센 edit —
    // as "the account writes Nansen in English six times, keep it", which is the opposite of true.
    const prose = CORPUS_TWEETS.map(proseText).join("\n");
    expect(countProse(prose, "Nansen")).toBe(0);
    // ...while the raw text really does contain six of them, so this test cannot pass vacuously.
    expect(CORPUS_TWEETS.join("\n").match(/nansen/gi)).toHaveLength(6);
  });

  it("anchors an ASCII term on word boundaries, so RWA does not count RWAfi", () => {
    // Two different products. Without the boundaries the count for a three-letter abbreviation is
    // whatever else happens to start with those letters — `AMM` inside `HAMMER` was the other one.
    expect(countProse("RWA and RWAfi are different products", "RWA")).toBe(1);
    expect(countProse("HAMMER time", "AMM")).toBe(0);
  });

  it("matches a Korean form literally, because word boundaries would anchor on nothing", () => {
    // JS `\b`-style boundaries sit at every Hangul/Hangul junction, i.e. they constrain nothing. The
    // consequence is accepted over-counting (규모 inside 규모의) on the side the rejection rule uses
    // as its floor, never on the side it uses as its zero.
    expect(countProse("규모 제한과 규모의 경제", "규모")).toBe(2);
  });

  it("folds case for ASCII and not for Korean", () => {
    expect(countProse("hackathon and Hackathon", "Hackathon")).toBe(2);
  });
});

// ── signal 1 ─────────────────────────────────────────────────────────────────────────────────────

describe("properNounRuns", () => {
  it("keeps a multi-word proper noun whole", () => {
    // The decision the account made is about the phrase — "모든 주문은 Atomic RFQ의 확정 호가로
    // 체결됩니다" — so splitting it into `Atomic` and `RFQ` would propose two terms neither of which
    // is the term.
    expect(properNounRuns("Every order fills at an Atomic RFQ firm quote.")).toContain("Atomic RFQ");
  });

  it("shaves a sentence-opening stopword off the front rather than proposing it", () => {
    // Without the shave, "The Mantle network is live" yields the run `The Mantle` — not a stopword,
    // not all stopwords, so both filters miss it — and the review file carries `The Mantle` as a
    // candidate distinct from `Mantle`.
    expect(properNounRuns("The Mantle network is live. We ship.")).toEqual(["Mantle"]);
  });

  it("drops a run made entirely of stopwords, which the whole-phrase check cannot see", () => {
    expect(properNounRuns("Every Day we ship")).toEqual([]);
  });

  it("never reads a term out of a handle or a link", () => {
    expect(properNounRuns("shipped with @Fluxion_network https://x.com/Mantle_Official/status/1")).toEqual([]);
  });
});

// ── signal 1's positional rule ───────────────────────────────────────────────────────────────────
//
// The filter that took the first real production fire from 170 candidates to 90. 110 of those 170
// were ordinary English words capitalized only because they opened a line or a heading — `Together`,
// `Tomorrow`, `Weekly`, `Winners`, `Everything`, `Still`, `Head`, `Register`, `Featuring` — and a
// longer stopword list is not the answer, because that list is endless and always one week behind
// whoever writes the tweets. Position is the property that separates the two: a name survives being
// written inside a clause, and a word that opens a line is just a word.

/** Every occurrence's verdict for one run, so a test can say "this one, in this line". */
const midVerdicts = (text: string, run: string): boolean[] =>
  properNounOccurrences(text).filter((o) => o.run === run).map((o) => o.midSentence);

describe("the positional rule", () => {
  it("calls a line-opening word line-initial and the same word inside a clause mid-sentence", () => {
    // The whole rule in one assertion, and it is a mutation check on itself: a rule stuck at `false`
    // fails the second expectation, a rule stuck at `true` fails the first. `Together` is a real
    // 2026-08-11 candidate; `Mantle` is the name it has to be told apart from.
    expect(midVerdicts("Together we ship.", "Together")).toEqual([false]);
    expect(midVerdicts("Built on Mantle since day one.", "Mantle")).toEqual([true]);
  });

  it("reads a bullet, a numbered item, a rule and a keycap emoji as decoration, not as prose", () => {
    // Every one of these opens a line in the real corpus: `→ Treasury yield`, `• Ran Mentor Clinic`,
    // `1️⃣ Follow`, `20) Head of Product`, and the `---` the account separates sections with. The
    // emoji case is the one that was actually wrong first time round: `1️⃣` is `1` + U+FE0F (Mn) +
    // U+20E3 (Me), so a decoration class of `[\s\p{N}\p{P}\p{S}]` leaves a mark behind, reads the
    // prefix as prose, and kept `Follow` and `Make` in the candidate list.
    expect(midVerdicts("→ Treasury yield", "Treasury")).toEqual([false]);
    expect(midVerdicts("• Ran Mentor Clinic Session 3", "Ran Mentor Clinic")).toEqual([false]);
    expect(midVerdicts("1️⃣ Follow the thread", "Follow")).toEqual([false]);
    expect(midVerdicts("20) Head of Product led it", "Head")).toEqual([false]);
    expect(midVerdicts("---\nWinners announced", "Winners")).toEqual([false]);
    expect(midVerdicts("$COOK holders vote", "COOK")).toEqual([false]);
  });

  it("reads the second sentence on a line as sentence-initial too", () => {
    // The line test alone cannot see this, and the real corpus has it: both occurrences of
    // `Knockouts` open a sentence and the word is not a name. `…` is in the terminator class with
    // `[.!?]` because the account writes it; without it the word after an ellipsis reads as prose.
    expect(midVerdicts("Knockouts on the pitch. Knockouts on the leaderboard.", "Knockouts")).toEqual([
      false,
      false,
    ]);
    expect(midVerdicts("we are close… Tomorrow it lands", "Tomorrow")).toEqual([false]);
    expect(midVerdicts("(finally!) Register here", "Register")).toEqual([false]);
  });

  it("counts a term after a colon or an em dash as mid-sentence", () => {
    // The edge case that could defensibly go either way, decided by measurement: cutting the line
    // prefix at the last `:`/`—` removes four more junk words from the real run and takes `AI Trading`
    // — a real hackathon track — with them. A review file survives four skimmable words far better
    // than it survives a missing name.
    expect(midVerdicts("Register: Mantle Super Portal", "Mantle Super Portal")).toEqual([true]);
    expect(midVerdicts("Speaker — Merchant Moe", "Merchant Moe")).toEqual([true]);
  });

  it("positions a shaved run where the survivor is, not where its stopword was", () => {
    // `The Chainlink CCIP` at the head of a line: the shave (see `properNounOccurrences`) leaves
    // `Chainlink CCIP`, which IS capitalized mid-sentence — the sentence opens with `The`. Measuring
    // the whole match's start instead loses `Chainlink CCIP` and `Absolute Mantle` from the real
    // corpus while removing exactly one junk word, so the survivor's own position is what is read.
    expect(midVerdicts("The Chainlink CCIP route is live", "Chainlink CCIP")).toEqual([true]);
    // ...and the shave itself still only takes LEADING stopwords, so this is not a way to smuggle a
    // line-initial name through: with no stopword to shave, position is the match's own.
    expect(midVerdicts("Chainlink CCIP is live", "Chainlink CCIP")).toEqual([false]);
  });

  it("drops a candidate no occurrence of which is ever mid-sentence", () => {
    // `Together` and `Tomorrow` clear every other filter in SOURCE_TWEETS — three occurrences each,
    // un-glossed, un-dismissed — and are removed by this rule alone.
    const result = mineGlossaryCandidates(input());
    expect(byKey(result, "Together")).toBeUndefined();
    expect(byKey(result, "Tomorrow")).toBeUndefined();
    // The mutation check from the other side: they really are in the source at a frequency that
    // would otherwise propose them, so this test cannot pass because the fixture is empty.
    const counts = new Map<string, number>();
    for (const t of SOURCE_TWEETS) for (const r of properNounRuns(t)) counts.set(r, (counts.get(r) ?? 0) + 1);
    expect(counts.get("Together")).toBe(3);
    expect(counts.get("Tomorrow")).toBe(3);
    expect(MIN_PROPER_NOUN_OCCURRENCES).toBeLessThanOrEqual(3);
  });

  it("keeps a term that opens the line in one tweet and sits mid-clause in another", () => {
    // **At least once, not always** — the half of the rule that costs the most to get wrong. `RWA`
    // opens five of its seven source lines and would be thrown away by an "always mid-sentence"
    // reading, along with every product name the account puts in a heading.
    const result = mineGlossaryCandidates(input());
    expect(byKey(result, "RWA")).toBeDefined();
    expect(byKey(result, "AMM")).toBeDefined();
    // Both really do open a line most of the time, so the assertion above is about the rule and not
    // about a fixture that never exercises it.
    expect(midVerdicts("RWA volume keeps climbing on Mantle.", "RWA")).toEqual([false]);
    expect(midVerdicts("Mantle leads every L2 in RWA capital deployed onchain.", "RWA")).toEqual([true]);
  });

  it("reports how many candidates it removed rather than removing them silently", () => {
    // A count, not a list — `rejected` is for an argument about one term a human may overrule, this is
    // a bulk property of the corpus (80 words on the first real run). Silence would leave "why is this
    // term missing" unanswerable, which is how a filter nobody trusts gets switched back off.
    const result = mineGlossaryCandidates(input());
    expect(result.sentenceInitialOnly).toBe(2);
    // ...and it counts CANDIDATES, not runs: a word the glossary already decides was never going to be
    // proposed, so removing it is not this rule's doing.
    const glossed = mineGlossaryCandidates(
      input({ glossary: [...GLOSSARY, entry("Together", "keep")] }),
    );
    expect(glossed.sentenceInitialOnly).toBe(1);
  });

  it("does not filter the source-term hints a substitution carries", () => {
    // Different question, different rule. `_원문_후보` answers "which English term is this Korean edit
    // about?" from ONE item's own text, next to the edit, for a human who is already reading the pair
    // — `Nansen` opens its source sentence and is still the right hint. The positional rule governs
    // what this module proposes UNPROMPTED, which is a claim about the whole corpus.
    const nansen = byKey(mineGlossaryCandidates(input()), "낸슨 → 난센")!;
    expect(nansen.sourceTerms).toContain("Nansen");
    expect(midVerdicts(TRANSLATIONS[0].sourceText, "Nansen")).toEqual([false]);
  });
});

describe("the recurrence floor", () => {
  it("proposes a proper noun seen twice and ignores one seen once", () => {
    // MIN_PROPER_NOUN_OCCURRENCES = 2. Mutation check from both sides in one assertion: `Fluxion`
    // appears exactly once in SOURCE_TWEETS and `Mentor Clinic` three times.
    expect(MIN_PROPER_NOUN_OCCURRENCES).toBe(2);
    const result = mineGlossaryCandidates(input());
    expect(byKey(result, "Fluxion")).toBeUndefined();
    expect(byKey(result, "Mentor Clinic")).toBeDefined();
  });

  it("loses a real 2026-08-11 entry at every floor above two", () => {
    // The mutation check, measured rather than asserted in a comment: `Mentor Clinic` (3 source
    // occurrences) and `AMM` (4) both became glossary entries that day, so a floor of 4 drops one and
    // a floor of 5 drops both. Two is the only value that keeps them while still excluding the
    // one-off `Fluxion` mention.
    const counts = new Map<string, number>();
    for (const t of SOURCE_TWEETS) for (const r of properNounRuns(t)) counts.set(r, (counts.get(r) ?? 0) + 1);
    expect(counts.get("Mentor Clinic")).toBe(3);
    expect(counts.get("AMM")).toBe(4);
    expect(counts.get("Fluxion")).toBe(1);
  });
});

// ── signal 2 ─────────────────────────────────────────────────────────────────────────────────────

// `substitutionEdits` now takes the generic `TextPair` (before/after) rather than `MinedTranslation`
// (koreanText/publishedText) — see EditSource. The fixtures below are still `MinedTranslation`,
// because they are shared with the `mineGlossaryCandidates` tests further down this file; this helper
// is the one place that reshapes them into the pair the function actually consumes, so the fixtures
// themselves stay untouched.
const asPublishedPair = (t: MinedTranslation): TextPair => ({
  itemId: t.itemId,
  before: t.koreanText,
  after: t.publishedText ?? "",
});

describe("substitutionEdits", () => {
  it("finds a one-word correction a human made once, with no frequency threshold at all", () => {
    // The run's best find. `mine2.cjs` required three or more occurrences and found NOTHING; this
    // edit exists exactly once in the whole ledger. A human editing a proper noun right before
    // publishing is the strongest evidence this pipeline produces, and it is almost never repeated.
    expect(substitutionEdits([asPublishedPair(TRANSLATIONS[0])], "published")).toEqual([
      { itemId: "x:2083206182484005059", draft: "낸슨", published: "난센", source: "published" },
    ]);
  });

  it("finds an English-to-Korean correction as a single multi-word pair", () => {
    expect(substitutionEdits([asPublishedPair(TRANSLATIONS[1])], "published")).toEqual([
      { itemId: "x:2081000000000000001", draft: "Turing Test", published: "튜링 테스트", source: "published" },
    ]);
  });

  it("ignores a sentence the human did not touch", () => {
    // SENTENCE_MATCH_MAX. Identical sentences score 1.0 and would otherwise be scored and diffed for
    // every unedited sentence of every published post.
    expect(SENTENCE_MATCH_MAX).toBe(0.995);
    const untouched = { ...TRANSLATIONS[0], publishedText: TRANSLATIONS[0].koreanText };
    expect(substitutionEdits([asPublishedPair(untouched)], "published")).toEqual([]);
  });

  it("ignores two sentences that are not the same sentence", () => {
    // SENTENCE_MATCH_MIN. Below the floor the aligner would diff a draft sentence against whichever
    // published sentence scored highest and report both vocabularies as a substitution.
    expect(SENTENCE_MATCH_MIN).toBe(0.55);
    const unrelated: MinedTranslation = {
      itemId: "x:9",
      sourceText: "Two unrelated posts.",
      koreanText: "맨틀 네트워크의 총 예치 자산이 늘었습니다",
      publishedText: "이번 주 커뮤니티 콜은 목요일에 열립니다",
    };
    expect(sentenceSimilarity(unrelated.koreanText, unrelated.publishedText!)).toBeLessThan(SENTENCE_MATCH_MIN);
    expect(substitutionEdits([asPublishedPair(unrelated)], "published")).toEqual([]);
  });

  it("ignores a rewrite, which carries no term decision", () => {
    // MAX_DIFF_WORDS = 4. Five-plus words changed on a side means the human re-said the sentence.
    expect(MAX_DIFF_WORDS).toBe(4);
    const rewritten: MinedTranslation = {
      itemId: "x:10",
      sourceText: "A rewrite.",
      koreanText: "맨틀 네트워크의 총 예치 자산이 이번 분기에 크게 늘었으며 앞으로도 계속 늘어날 예정입니다",
      publishedText: "맨틀 네트워크의 총 예치 규모는 올해 들어 꾸준하게 증가했으며 앞으로도 계속 늘어날 예정입니다",
    };
    const score = sentenceSimilarity(rewritten.koreanText, rewritten.publishedText!);
    expect(score).toBeGreaterThanOrEqual(SENTENCE_MATCH_MIN);
    expect(substitutionEdits([asPublishedPair(rewritten)], "published")).toEqual([]);
  });

  it("ignores a pure insertion and a pure deletion", () => {
    // Nothing was decided — a clause was added or dropped — so there is no "instead of what" to put
    // in a glossary entry.
    const inserted: MinedTranslation = {
      itemId: "x:11",
      sourceText: "An insertion.",
      koreanText: "맨틀 네트워크의 예치 자산이 늘었습니다",
      publishedText: "맨틀 네트워크의 예치 자산이 크게 늘었습니다",
    };
    expect(substitutionEdits([asPublishedPair(inserted)], "published")).toEqual([]);
  });

  it("skips a row with no published text — nobody has captured what went out", () => {
    expect(substitutionEdits([asPublishedPair({ ...TRANSLATIONS[0], publishedText: undefined })], "published")).toEqual(
      [],
    );
  });

  it("mines a reviewer's edit with the same aligner, tagged as review evidence", () => {
    const edits = substitutionEdits(
      [{ itemId: "x:1", before: "가장 최근에 구매하신 토큰화 자산은 무엇입니까?", after: "가장 최근에 구매한 토큰화 자산은 무엇인가요?" }],
      "review",
    );
    // The brief predicted trailing "?" on both sides; `sentencesOf` splits on `[\n.!?]+`, which
    // consumes the terminator as a delimiter rather than keeping it, so the aligner's sentences —
    // and therefore its words — never carry one. Corrected to what the aligner actually produces.
    expect(edits).toEqual([{ itemId: "x:1", draft: "구매하신 무엇입니까", published: "구매한 무엇인가요", source: "review" }]);
  });
});

// ── signal 3: the rejection rule ─────────────────────────────────────────────────────────────────

describe("the rejection rule", () => {
  it("throws away 시장 가격 → 시장가, which the corpus says was a one-off", () => {
    // Real. Corpus 2 : 0 — the account writes 시장 가격 and has never written 시장가. Without this
    // rule the edit becomes a glossary entry and every future post is asked to say 시장가.
    const result = mineGlossaryCandidates(input());
    expect(byKey(result, "시장 가격 → 시장가")).toBeUndefined();
    const rejected = result.rejected.find((r) => r.key === "시장 가격 → 시장가");
    expect(rejected).toBeDefined();
    expect(rejected!.corpus).toEqual({ ours: 2, theirs: 0 });
  });

  it("throws away 규모 → 사이즈, an order of magnitude louder", () => {
    const result = mineGlossaryCandidates(input());
    expect(byKey(result, "규모 → 사이즈")).toBeUndefined();
    expect(result.rejected.find((r) => r.key === "규모 → 사이즈")!.corpus).toEqual({ ours: 13, theirs: 0 });
  });

  it("keeps 낸슨 → 난센, where the corpus is silent on BOTH forms", () => {
    // The case the whole threshold is shaped around. 0 : 0 is not evidence against the edit, it is no
    // evidence at all, and the human's one correction is then the only evidence in existence. A rule
    // written as "theirs === 0 → reject" loses this.
    const result = mineGlossaryCandidates(input());
    const nansen = byKey(result, "낸슨 → 난센");
    expect(nansen).toBeDefined();
    expect(nansen!.corpus).toEqual({ ours: 0, theirs: 0 });
    expect(nansen!.target).toBe("난센");
    expect(nansen!.itemIds).toEqual(["x:2083206182484005059"]);
  });

  it("offers the English term the substitution is probably about", () => {
    // The machine cannot turn 난센 into `Nansen` — but the item's own source text names it, and a
    // review file that says "this is probably about Nansen" is the difference between a line a human
    // can act on and one they have to go look up.
    const nansen = byKey(mineGlossaryCandidates(input()), "낸슨 → 난센")!;
    expect(nansen.sourceTerms).toContain("Nansen");
  });

  it("keeps Turing Test → 튜링 테스트, because the corpus itself is mixed", () => {
    // 9 English : 5 Korean. `theirs` is not zero, so the rejection rule does not fire, and the mixture
    // is the reason a glossary decision is worth making at all.
    const result = mineGlossaryCandidates(input());
    const turing = byKey(result, "Turing Test → 튜링 테스트");
    expect(turing).toBeDefined();
    expect(turing!.corpus).toEqual({ ours: 9, theirs: 5 });
    expect(turing!.tier).toBe("B");
  });

  it("would let 시장가 through if REJECT_MIN_OURS were raised to three", () => {
    // The mutation check that matters most. 시장 가격 scores exactly 2 in the real corpus, so a
    // threshold of 3 writes a wrong rendering into the glossary — and 3 is the obvious "make it
    // stricter" edit somebody makes when the rejected list looks aggressive.
    expect(REJECT_MIN_OURS).toBe(2);
    const prose = CORPUS_TWEETS.map(proseText).join("\n");
    expect(countProse(prose, "시장 가격")).toBe(2);
    expect(countProse(prose, "시장가")).toBe(0);
  });

  it("rejects nothing at all when there is no corpus to argue with", () => {
    // A rejection is a claim about what the account writes. With no corpus there is no such claim,
    // and throwing candidates away on no evidence is strictly worse than showing them.
    const result = mineGlossaryCandidates(input({ corpusTweets: [], corpusRuns: [] }));
    expect(result.rejected).toEqual([]);
    expect(byKey(result, "규모 → 사이즈")).toBeDefined();
  });
});

// ── tiering ──────────────────────────────────────────────────────────────────────────────────────

describe("tierFor", () => {
  const fresh: CorpusStatus = {
    state: "fresh",
    tweetCount: 118,
    coveredFrom: "2026-06-01T00:00:00.000Z",
    coveredTo: "2026-08-11T00:00:00.000Z",
    ageDays: 0,
  };

  it("grades a proper noun A at four corpus occurrences and B at three", () => {
    // Read off the approved 2026-08-11 draft's own A/B split: `AMM` (4) was graded A and
    // `Mentor Clinic` (3) B, by a human who had read every hit.
    expect(TIER_A_MIN_CORPUS).toBe(4);
    expect(tierFor(fresh, { ours: 4 })).toBe("A");
    expect(tierFor(fresh, { ours: 3 })).toBe("B");
  });

  it("never grades a proper noun A on a corpus ZERO, however loud our own source is", () => {
    // "they transliterate it" and "they have never discussed it" produce the identical zero, and only
    // the Korean form — which this signal never learns — tells them apart. This is the one place the
    // machine deliberately grades lower than the 2026-08-11 human did (they had counted 월드컵 by hand).
    expect(tierFor(fresh, { ours: 0 })).toBe("B");
  });

  it("grades a substitution A only when the corpus is one-sided in the human's favour", () => {
    expect(tierFor(fresh, { ours: 0, theirs: 4 })).toBe("A");
    expect(tierFor(fresh, { ours: 1, theirs: 4 })).toBe("B"); // mixed
    expect(tierFor(fresh, { ours: 0, theirs: 3 })).toBe("B"); // small
  });

  it("caps every tier at B when the corpus is missing, undated or stale", () => {
    // The rule that outranks the others. Degraded cross-validation must make grades LESS confident;
    // a machine with no evidence handing back the same confident A as one with twenty-four
    // occurrences is the failure this exists to prevent.
    const stale: CorpusStatus = { ...fresh, state: "stale", ageDays: 90 };
    expect(tierFor({ state: "missing" }, { ours: 40 })).toBe("B");
    expect(tierFor({ state: "undated", tweetCount: 118 }, { ours: 40 })).toBe("B");
    expect(tierFor(stale, { ours: 40 })).toBe("B");
    expect(tierFor(fresh, undefined)).toBe("B");
  });
});

describe("tiering, end to end", () => {
  it("puts the loud keep-candidates in A with a keep rule", () => {
    const result = mineGlossaryCandidates(input());
    const rwa = byKey(result, "RWA")!;
    expect(rwa.tier).toBe("A");
    expect(rwa.rule).toBe("keep");
    expect(rwa.corpus).toEqual({ ours: 24 });
    expect(byKey(result, "Atomic RFQ")!.tier).toBe("A");
  });

  it("puts a term the corpus never writes in English in B, with no rule guessed", () => {
    // `Mentor Clinic`: 0 corpus occurrences in English. The right output is a question, not a guess —
    // a wrong `rule` a human has to notice and undo is worse than a blank one they have to fill.
    const clinic = byKey(mineGlossaryCandidates(input()), "Mentor Clinic")!;
    expect(clinic.tier).toBe("B");
    expect(clinic.rule).toBeUndefined();
    expect(clinic.note).toContain("직접 채워");
  });

  it("orders A before B and never reshuffles two runs that found the same things", () => {
    // The alert is read on a phone; a list that changes order for no reason reads as new information.
    const first = mineGlossaryCandidates(input()).candidates.map((c) => c.key);
    const again = mineGlossaryCandidates(input()).candidates.map((c) => c.key);
    expect(again).toEqual(first);
    expect(first.indexOf("RWA")).toBeLessThan(first.indexOf("Mentor Clinic"));
  });
});

// ── what is already answered ─────────────────────────────────────────────────────────────────────

describe("terms that are not open questions", () => {
  it("never proposes a term the glossary already decides", () => {
    expect(byKey(mineGlossaryCandidates(input()), "Mantle")).toBeUndefined();
  });

  it("never proposes a substitution that lands on a decided form, in either direction", () => {
    // Landing ON a decided form is settled. Moving AWAY from one is `checkPublishedOverrides`
    // (glossaryCompliance.ts), which `translate:check` reports and pages on — the same finding in two
    // weekly alerts that call for opposite responses is how both get ignored.
    const withDecision = mineGlossaryCandidates(
      input({ glossary: [...GLOSSARY, entry("Nansen", "transliterate", "난센")] }),
    );
    expect(byKey(withDecision, "낸슨 → 난센")).toBeUndefined();

    const draftSideDecided = mineGlossaryCandidates(
      input({ glossary: [...GLOSSARY, entry("Nansen", "transliterate", "낸슨")] }),
    );
    expect(byKey(draftSideDecided, "낸슨 → 난센")).toBeUndefined();
  });

  it("lets a surviving substitution suppress the contradicting proper-noun candidate", () => {
    // `Turing Test` is both: an un-glossed proper noun our source repeats (signal 1 would say "corpus
    // writes it in English 9 times — keep") and a term a human rewrote to 튜링 테스트 (signal 2 says
    // "transliterate"). Two opposite recommendations in one review file is worse than either.
    const keys = mineGlossaryCandidates(input()).candidates.map((c) => c.key);
    expect(keys).toContain("Turing Test → 튜링 테스트");
    expect(keys).not.toContain("Turing Test");
  });
});

// ── the dismissal list ───────────────────────────────────────────────────────────────────────────

describe("the dismissal list", () => {
  it("silences a proper noun a human has said no to", () => {
    const result = mineGlossaryCandidates(input({ dismissed: [{ term: "Mentor Clinic" }] }));
    expect(byKey(result, "Mentor Clinic")).toBeUndefined();
    expect(byKey(result, "RWA")).toBeDefined();
  });

  it("silences a substitution by the exact key the review file prints", () => {
    const result = mineGlossaryCandidates(input({ dismissed: [{ term: "낸슨 → 난센" }] }));
    expect(byKey(result, "낸슨 → 난센")).toBeUndefined();
  });

  it("forgives case and stray whitespace in a hand-typed dismissal", () => {
    // The file is edited by a person in a text editor. A dismissal that fails to match because of a
    // double space is a dismissal that silently does nothing, and the symptom is the candidate coming
    // back next Monday — which reads as the dismissal file not working at all.
    const result = mineGlossaryCandidates(input({ dismissed: [{ term: "  mentor   clinic " }] }));
    expect(byKey(result, "Mentor Clinic")).toBeUndefined();
  });
});

// ── corpus freshness ─────────────────────────────────────────────────────────────────────────────

describe("gradeCorpus", () => {
  it("reports missing when there are no corpus tweets", () => {
    expect(gradeCorpus(0, CORPUS_RUNS, NOW)).toEqual({ state: "missing" });
  });

  it("reports undated when the tweets are there but the run ledger is not", () => {
    // Counts are still real; their vintage is unknown, which is a different degradation from having
    // no counts at all and must not be collapsed into it.
    expect(gradeCorpus(118, [], NOW)).toEqual({ state: "undated", tweetCount: 118 });
    expect(gradeCorpus(118, [{ covered: null }], NOW)).toEqual({ state: "undated", tweetCount: 118 });
  });

  it("reads coverage from the widest run, not the last one", () => {
    // The ledger is append-ordered by RUN. A `collect:reference --since 2026-06-01` backfill appended
    // after a routine incremental run covers older ground while being newer in the file, so
    // `runs.at(-1).covered.to` is correct only by accident.
    const graded = gradeCorpus(118, [
      { covered: { from: "2026-07-29T00:00:00.000Z", to: "2026-08-11T04:00:00.000Z" } },
      { covered: { from: "2026-06-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" } },
    ], NOW);
    expect(graded).toMatchObject({ coveredFrom: "2026-06-01T00:00:00.000Z", coveredTo: "2026-08-11T04:00:00.000Z" });
  });

  it("goes stale one day past the threshold and not before", () => {
    // 28 days = four fires of the weekly timer. Pinned on both sides, because a bound that only fails
    // in one direction can be doubled without any test noticing.
    expect(REFERENCE_STALE_AFTER_DAYS).toBe(28);
    const to = (days: number): string => new Date(Date.parse(NOW) - days * 24 * 3600 * 1000).toISOString();
    expect(gradeCorpus(118, [{ covered: { from: to(90), to: to(28) } }], NOW).state).toBe("fresh");
    expect(gradeCorpus(118, [{ covered: { from: to(90), to: to(29) } }], NOW).state).toBe("stale");
  });

  it("treats an unparseable coverage date as undated rather than as age zero", () => {
    // NaN comparisons are false, so `ageDays > threshold` would come out "fresh" — the degraded state
    // silently reading as the good one, which is the exact failure `tierFor`'s cap exists to prevent.
    expect(gradeCorpus(118, [{ covered: { from: "?", to: "not-a-date" } }], NOW)).toEqual({
      state: "undated",
      tweetCount: 118,
    });
  });
});

describe("a degraded corpus", () => {
  it("still mines candidates when the corpus is missing entirely, and grades them all B", () => {
    const result = mineGlossaryCandidates(input({ corpusTweets: [], corpusRuns: [] }));
    expect(result.corpus).toEqual({ state: "missing" });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.tier === "B")).toBe(true);
    expect(result.candidates.every((c) => c.corpus === undefined)).toBe(true);
    expect(byKey(result, "RWA")!.note).toContain("참조 코퍼스가 없어");
  });

  it("keeps counting against a stale corpus but refuses to promote anything", () => {
    // Staleness does not make the counts wrong, it makes a ZERO ambiguous — and the rejection rule
    // reads zeros. So the counts stay, the rejections stay, and the confidence goes.
    const old = [{ covered: { from: "2026-01-01T00:00:00.000Z", to: "2026-05-01T00:00:00.000Z" } }];
    const result = mineGlossaryCandidates(input({ corpusRuns: old }));
    expect(result.corpus.state).toBe("stale");
    expect(result.candidates.every((c) => c.tier === "B")).toBe(true);
    expect(byKey(result, "RWA")!.corpus).toEqual({ ours: 24 });
    expect(result.rejected.map((r) => r.key)).toContain("규모 → 사이즈");
  });
});
