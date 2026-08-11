import type { GlossaryEntry, GlossaryDismissal, GlossaryRule } from "./models";

/**
 * Which terms are still waiting on a glossary DECISION — the question `translate:check` cannot ask.
 *
 * `translate:check` measures translations against decisions already recorded: did the draft use the
 * decided term (`checkGlossary`), and did the human take it back out (`checkPublishedOverrides`).
 * Both are silent about a term nobody has decided yet, and that silence is the bottleneck this
 * module exists for — not "where do I type a glossary entry", but "which terms need one".
 *
 * Three signals, prototyped by hand against production on 2026-08-11 and kept at the thresholds that
 * run produced. It proposed ten entries; every one was applied, taking the glossary from 96 to 106.
 *
 *   1. Un-glossed recurring proper nouns in the English source (`properNounCandidates`).
 *   2. Word-level substitutions a human made between our draft and the published post
 *      (`substitutionEdits`) — the only signal that ever carries the human's own answer.
 *   3. Cross-validation against the @0xMantleKR reference corpus (`crossValidate`), which is what
 *      turns a candidate into a decision, and — more importantly — what throws two of them away.
 *
 * Everything here is pure: no clock (the caller passes `now`), no I/O, no `process.env`. The
 * thresholds are exported so a test can mutate them, because every one of them was measured rather
 * than chosen, and a measured constant with no failing test is a number nobody may safely edit.
 */

// ── Text normalization, shared by every signal ───────────────────────────────────────────────────

/**
 * A tweet with its links and @handles removed — the only form any counting here is allowed to see.
 *
 * The handle strip is not cosmetic; it is what makes the reference corpus answer the question we are
 * actually asking. Measured on the 85-thread corpus: `Nansen` matches six times with word boundaries
 * and case folding, and ALL SIX are `@nansen_ai` or an `x.com/nansen_ai/...` URL. Counting those
 * would have said "the account writes Nansen in English six times, keep it" — the exact opposite of
 * the truth, which is that the account had never written the word in prose at all, and the single
 * human edit 낸슨 → 난센 was therefore the only evidence in existence. `occursAsProse`
 * (glossaryCompliance.ts) fights the same false positive from the other side, on the source text.
 */
export function proseText(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/@[A-Za-z0-9_]+/g, " ");
}

/** Escape a candidate for use inside a RegExp — terms carry `(`, `.`, `-`, `$`. */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Collapse for identity comparisons: a term is the same term with different spacing or case. */
export const normalizeTerm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * How many times `form` occurs in already-`proseText`'d text.
 *
 * ASCII forms get word boundaries and case folding; anything with a Korean character gets a literal
 * substring match. Both halves are load-bearing and both were measured:
 *
 * - Without boundaries, `RWA` counts `RWAfi` — a real, different product the account names — and
 *   `AMM` counts every `HAMMER`. Spelled as a pair of lookarounds rather than `\b`, matching
 *   `occursAsProse`, so a term ending in punctuation (`pre-IPO`) still anchors correctly.
 * - With boundaries and the `u`-less regex JS gives us, a Korean form would anchor on nothing:
 *   `\b`-style boundaries around 규모 match at every Hangul/Hangul junction, which is no constraint
 *   at all. Korean is therefore matched literally and case-sensitively, which slightly over-counts
 *   (`규모` inside `규모의`) — accepted, because it over-counts the side the rejection rule below
 *   uses as its FLOOR, never the side it uses as its zero.
 */
export function countProse(prose: string, form: string): number {
  const trimmed = form.trim();
  if (trimmed === "") return 0;
  const ascii = /^[\x20-\x7E]+$/.test(trimmed);
  const body = escape(trimmed);
  const pattern = ascii ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body;
  return (prose.match(new RegExp(pattern, ascii ? "gi" : "g")) ?? []).length;
}

// ── Signal 1: un-glossed recurring proper nouns ──────────────────────────────────────────────────

/**
 * Capitalized words that start sentences and mean nothing as terms.
 *
 * Carried over verbatim from the 2026-08-11 sweep rather than regenerated, because it is the product
 * of reading that run's output: every entry here was a line somebody had to skip past. A shorter list
 * buries the eight real findings under "The", "This" and "Every"; a longer one starts eating product
 * names (`Live`, `Access` and `Capital` are already uncomfortably close to that line, and are here
 * only because the account uses all three as sentence openers).
 */
export const PROPER_NOUN_STOPWORDS = new Set<string>([
  "The", "This", "That", "And", "But", "For", "With", "From", "Your", "You", "Our", "Now", "Every",
  "All", "New", "More", "Not", "What", "When", "Where", "Who", "Why", "How", "One", "Two", "Here",
  "There", "Then", "It", "Is", "Are", "We", "They", "A", "An", "In", "On", "At", "To", "Of", "As",
  "So", "If", "No", "Yes", "Live", "Read", "See", "Get", "Go", "Start", "Join", "Watch", "Learn",
  "Full", "Real", "Next", "Last", "First", "Day", "Week", "Today", "Access", "Trade", "Capital",
  "Built", "Made", "Take", "Just", "Use", "Open", "Close",
]);

/**
 * Minimum times a proper noun must appear across the collected English source before it is worth a
 * human's attention.
 *
 * Two, not three. The whole corpus is ~523 tweets and a term used once is usually a one-off partner
 * mention; a term used twice is already a pattern this account repeats. Raising it to three drops
 * `AMM` and `Mentor Clinic`, both of which became glossary entries on 2026-08-11.
 */
export const MIN_PROPER_NOUN_OCCURRENCES = 2;

/**
 * Capitalized 1–3 word runs. Greedy on purpose: `Atomic RFQ` must arrive as one candidate, not as
 * `Atomic` and `RFQ` separately, because the decision the account actually made ("모든 주문은 Atomic
 * RFQ의 확정 호가로 체결됩니다") is about the phrase. The cost is that a genuinely standalone word
 * inside a longer run is never proposed on its own; that showed up in the real run as nothing at all,
 * since the sub-words are almost always stopwords or already glossed.
 */
export function properNounRuns(text: string): string[] {
  const out: string[] = [];
  for (const m of proseText(text).matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g)) {
    // Leading stopwords are shaved off rather than disqualifying the run, because the noise they
    // cause is almost entirely sentence-initial capitalization: "The Mantle network…" produces the
    // run `The Mantle`, which is neither a stopword nor all-stopwords, so both filters below miss it
    // and `The Mantle` becomes a candidate distinct from `Mantle`. Shaving recovers the real term.
    // LEADING only, never trailing: a capitalized stopword mid-phrase is rare (a stopword mid-sentence
    // is lowercase), while trailing-shaving would turn a real event name like `Mantle Day` into
    // `Mantle`.
    const words = m[1].trim().split(/\s+/);
    while (words.length > 0 && PROPER_NOUN_STOPWORDS.has(words[0])) words.shift();
    const run = words.join(" ");
    if (run.length < 3) continue;
    if (PROPER_NOUN_STOPWORDS.has(run)) continue;
    // A multi-word run made entirely of stopwords ("Every Day") is still noise, and the whole-phrase
    // check above cannot see it. Unreachable after the shave above for a leading stopword, kept
    // because the shave stops at the first non-stopword and a later one can still be there.
    if (words.every((w) => PROPER_NOUN_STOPWORDS.has(w))) continue;
    out.push(run);
  }
  return out;
}

// ── Signal 2: draft-vs-published substitutions ───────────────────────────────────────────────────

/**
 * Sentence-similarity band for treating a draft sentence and a published sentence as THE SAME
 * sentence, differing only in wording.
 *
 * Both ends were measured on the real 14-pair ledger and both matter:
 *
 * - Below 0.55 the two sentences are not the same sentence. The aligner would then diff a draft
 *   sentence against whichever published sentence happened to score highest, and report the whole
 *   vocabulary of both as a "substitution".
 * - Above 0.995 they are byte-identical (or differ by a space), so there is no edit to report and the
 *   pair is pure noise — every unedited sentence in every published post would otherwise be scored
 *   and diffed.
 */
export const SENTENCE_MATCH_MIN = 0.55;
export const SENTENCE_MATCH_MAX = 0.995;

/**
 * Largest word count on EITHER side of a diff still treated as a term decision.
 *
 * Five or more words changed is a rewrite — the human re-said the sentence — and a rewrite carries no
 * term decision to extract. Four was where the real ledger separated cleanly: every genuine finding
 * (`낸슨 → 난센`, `Turing Test → 튜링 테스트`, `시장 가격 → 시장가`) is one or two words a side, and
 * everything at five or above was a re-phrasing.
 *
 * There is deliberately NO frequency threshold on this signal, unlike signal 1. The single best find
 * of the entire 2026-08-11 run — `낸슨 → 난센` — occurred exactly once, and an earlier attempt
 * (`mine2.cjs`) that required three or more occurrences found nothing at all. A human editing a
 * proper noun once, right before publishing, is the strongest evidence this pipeline ever produces.
 */
export const MAX_DIFF_WORDS = 4;

/** Strip what is markup rather than prose before splitting into sentences. */
const cleanForSentences = (text: string): string =>
  (text ?? "").replace(/https?:\/\/\S+/g, "").replace(/\[사진\]|\[영상\]|---/g, "").replace(/[ \t]+/g, " ");

/**
 * Sentences, split on newlines and terminal punctuation. The 8-character floor drops list bullets,
 * bare emoji lines and `1)` markers, which align against each other at high similarity and diff to
 * nothing useful.
 */
export function sentencesOf(text: string): string[] {
  return cleanForSentences(text)
    .split(/[\n.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

/** Character bigrams of a string, deduplicated. */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Dice coefficient over character bigrams, in [0, 1].
 *
 * Bigrams rather than the 3-grams `src/domain/kol/attribution.ts` uses, and Dice rather than its
 * Jaccard: this compares two versions of ONE sentence, where the interesting difference is a single
 * word, and 3-grams over Korean make a two-syllable substitution look like a bigger change than it
 * is. The two functions answer different questions and are deliberately not shared.
 */
export function sentenceSimilarity(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}

/** One word-level edit a human made between our draft and the post that actually went out. */
export interface SubstitutionEdit {
  itemId: string;
  /** The words only our draft had. */
  draft: string;
  /** The words only the published post had. */
  published: string;
}

export interface MinedTranslation {
  itemId: string;
  sourceText: string;
  koreanText: string;
  publishedText?: string;
}

/**
 * Every word-level substitution between a translation's draft and its published text.
 *
 * Alignment is greedy and one-directional — each draft sentence takes its best published match, and
 * a published sentence may be claimed twice. Deliberately not the Hungarian assignment it looks like
 * it wants to be: the pairs are near-duplicates of each other, so the greedy pick and the optimal one
 * agreed on every sentence of the real ledger, and an aligner nobody can read is a worse trade than a
 * duplicate line in a review file a human is going to read anyway.
 */
export function substitutionEdits(translations: MinedTranslation[]): SubstitutionEdit[] {
  const edits: SubstitutionEdit[] = [];
  for (const t of translations) {
    if (!t.publishedText || !t.koreanText) continue;
    const draftSentences = sentencesOf(t.koreanText);
    const publishedSentences = sentencesOf(t.publishedText);

    for (const draft of draftSentences) {
      let best: string | undefined;
      let bestScore = 0;
      for (const published of publishedSentences) {
        const score = sentenceSimilarity(draft, published);
        if (score > bestScore) {
          bestScore = score;
          best = published;
        }
      }
      if (best === undefined) continue;
      if (bestScore < SENTENCE_MATCH_MIN || bestScore > SENTENCE_MATCH_MAX) continue;

      const draftWords = draft.split(/\s+/).filter(Boolean);
      const publishedWords = best.split(/\s+/).filter(Boolean);
      const inPublished = new Set(publishedWords);
      const inDraft = new Set(draftWords);
      const gone = draftWords.filter((w) => !inPublished.has(w));
      const came = publishedWords.filter((w) => !inDraft.has(w));

      // A pure deletion or a pure insertion is not a substitution — nothing was decided, a clause was
      // dropped or added — and it has no "instead of what" to put in a glossary entry.
      if (gone.length === 0 || came.length === 0) continue;
      if (gone.length > MAX_DIFF_WORDS || came.length > MAX_DIFF_WORDS) continue;

      edits.push({ itemId: t.itemId, draft: gone.join(" "), published: came.join(" ") });
    }
  }
  return edits;
}

// ── Signal 3: cross-validation, tiering, and the rejection rule ──────────────────────────────────

/**
 * Corpus occurrences on each side of a candidate. `theirs` is absent for a proper noun: nothing tells
 * us which Korean string to count, which is precisely why a proper noun can never reach tier A on a
 * "do not keep" reading (see `tierFor`).
 */
export interface CorpusEvidence {
  /** Occurrences of the form OUR draft used — the English term, or the draft's Korean. */
  ours: number;
  /** Occurrences of the human's replacement. Substitutions only. */
  theirs?: number;
}

/**
 * Corpus occurrences on the winning side needed for tier A.
 *
 * Four, read off the approved 2026-08-11 draft's own A/B split rather than picked: `AMM` (4 corpus
 * occurrences) was graded A and `Mentor Clinic` (3) was graded B, by a human who had read every hit.
 * Below four the sample is small enough that a single unusual post moves the answer, which is exactly
 * what tier B means.
 */
export const TIER_A_MIN_CORPUS = 4;

/**
 * How many corpus occurrences OUR form needs before a zero for the human's form is read as "that edit
 * was a one-off" rather than "the corpus is quiet about both".
 *
 * Two, and this is the single most consequential number in the file — it is what makes the corpus a
 * discriminator instead of a rubber stamp. On the real run it rejected two candidates that would
 * otherwise have been written into the glossary as wrong renderings:
 *
 *   시장 가격 → 시장가   corpus 2 : 0   (the account writes 시장 가격; the edit appears nowhere)
 *   규모 → 사이즈        corpus 13 : 0  (same, an order of magnitude louder)
 *
 * and it deliberately did NOT reject the run's best find, because that one has no corpus support on
 * either side:
 *
 *   낸슨 → 난센          corpus 0 : 0   (the account had never written the word in prose)
 *
 * Raising this to 3 lets 시장가 through — a wrong glossary entry, applied to every future post.
 * Lowering it to 1 is worse: a single corpus occurrence of our draft's wording is noise, and the rule
 * would start throwing away real human corrections on the strength of one sentence.
 */
export const REJECT_MIN_OURS = 2;

/**
 * How old the reference corpus's newest content may be before this run says so out loud.
 *
 * 28 days, i.e. four fires of the weekly timer. The bound is set by what staleness does to the
 * REJECTION rule rather than by the corpus's own decay: a rejection reads a zero as "the account does
 * not write it that way", and a corpus that stops before a term entered circulation produces the
 * identical zero from "we never collected it". @0xMantleKR ran 85 threads across the ten weeks to
 * 2026-08-11 (~8/week), so a term the account has adopted shows up within one or two weeks; four
 * weeks is comfortably past that, which makes a zero at that age genuinely ambiguous. Four fires is
 * also the point at which "somebody will run `collect:reference`" has demonstrably not happened —
 * nothing schedules it, by design, because weekly collection would spend twitterapi.io budget on data
 * that is overwhelmingly historical.
 */
export const REFERENCE_STALE_AFTER_DAYS = 28;

/**
 * What the cross-validation corpus was actually able to contribute, in the four states the caller can
 * hand this module. Three of them cap every candidate at tier B (`tierFor`), and all four are
 * reported to the operator verbatim — a grading that silently got easier is the failure this type
 * exists to make impossible.
 */
export type CorpusStatus =
  /** No `x/reference/items.json`, or it holds no tweets. No cross-validation at all. */
  | { state: "missing" }
  /** Tweets, but no readable `x/reference/runs.json` — counts are real, their vintage is unknown. */
  | { state: "undated"; tweetCount: number }
  | { state: "fresh" | "stale"; tweetCount: number; coveredFrom: string; coveredTo: string; ageDays: number };

/** One entry in `x/reference/runs.json`, narrowed to the two fields staleness needs. */
export interface ReferenceRun {
  covered: { from: string; to: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Grade the corpus from its own run ledger, never from a file mtime: `deploy:freeze` copies steering
 * files and `state:pull` rewrites artifacts, so an mtime says when a file was last WRITTEN, and the
 * only question here is how recent the CONTENT is. `covered.to` is the newest tweet the collector
 * actually stored (`computeCoverage`, src/domain/coverage.ts), which is exactly that.
 *
 * The maximum across runs, not the last entry's: the ledger is append-ordered by run, and a
 * `collect:reference --since 2026-06-01` backfill appended AFTER a routine incremental run covers
 * older ground while being newer in the file. Reading `runs.at(-1)` would report the backfill's own
 * `covered.to`, which is correct only by accident.
 */
export function gradeCorpus(tweetCount: number, runs: ReferenceRun[], now: string): CorpusStatus {
  if (tweetCount === 0) return { state: "missing" };
  const covered = runs.map((r) => r.covered).filter((c): c is { from: string; to: string } => c !== null);
  if (covered.length === 0) return { state: "undated", tweetCount };

  const coveredFrom = covered.reduce((a, c) => (c.from < a ? c.from : a), covered[0].from);
  const coveredTo = covered.reduce((a, c) => (c.to > a ? c.to : a), covered[0].to);
  const ageMs = Date.parse(now) - Date.parse(coveredTo);
  // An unparseable `covered.to` must not read as age 0 — NaN comparisons are false, so the state
  // would silently come out "fresh". Treated as undated instead: the counts are still real.
  if (!Number.isFinite(ageMs)) return { state: "undated", tweetCount };
  const ageDays = Math.floor(ageMs / DAY_MS);

  return {
    state: ageDays > REFERENCE_STALE_AFTER_DAYS ? "stale" : "fresh",
    tweetCount,
    coveredFrom,
    coveredTo,
    ageDays,
  };
}

/** Only a `fresh` corpus may promote a candidate past tier B — see `tierFor`. */
export const corpusIsFresh = (corpus: CorpusStatus): boolean => corpus.state === "fresh";

// ── Candidates ───────────────────────────────────────────────────────────────────────────────────

export type CandidateSignal = "proper-noun" | "substitution";
export type CandidateTier = "A" | "B";

export interface GlossaryCandidate {
  /**
   * Stable identity — what a human puts in `translation/glossary-dismissed.json` to silence this
   * candidate forever. A proper noun is keyed by the term; a substitution by `draft → published`,
   * because its `term` is the one field the machine cannot fill in and therefore cannot key on.
   */
  key: string;
  signal: CandidateSignal;
  tier: CandidateTier;
  /** Filled for a proper noun. For a substitution this is the human's Korean, awaiting the source term. */
  term: string;
  /** Substitution only. */
  draft?: string;
  /** Substitution only. */
  published?: string;
  /** Substitution only: un-glossed proper nouns in that item's source text — the term's likely name. */
  sourceTerms?: string[];
  /** Times the signal fired in OUR data: source tweets for a proper noun, edits for a substitution. */
  occurrences: number;
  /** Substitution only. */
  itemIds?: string[];
  /** Absent when there was no corpus to ask. */
  corpus?: CorpusEvidence;
  /** What the corpus supports, when it supports anything. Left unset for a human to decide. */
  rule?: GlossaryRule;
  target?: string;
  note: string;
  /** Ready to paste into `pnpm glossary add --source`. */
  source: string;
}

/** A candidate the corpus argued against — kept, listed, and never silently dropped. */
export interface RejectedCandidate {
  key: string;
  draft: string;
  published: string;
  itemIds: string[];
  corpus: CorpusEvidence;
  reason: string;
}

export interface MiningInput {
  /** Every tweet text in `x_threads` — the English source, deleted threads included. */
  sourceTweets: string[];
  translations: MinedTranslation[];
  glossary: GlossaryEntry[];
  dismissed: GlossaryDismissal[];
  /** Every tweet text in the reference corpus. Empty when the corpus is absent. */
  corpusTweets: string[];
  /** `x/reference/runs.json`. Empty when unreadable. */
  corpusRuns: ReferenceRun[];
  /** ISO instant. Passed in so this module reads no clock. */
  now: string;
}

export interface MiningResult {
  candidates: GlossaryCandidate[];
  rejected: RejectedCandidate[];
  corpus: CorpusStatus;
}

/** What a glossary entry actually asks a translation to say — the same derivation `checkGlossary` uses. */
const expectedForm = (e: GlossaryEntry): string => (e.rule === "keep" ? e.term : e.target ?? e.term);

/**
 * Tier, with the one rule that outranks every other: **a corpus that is missing, undated or stale can
 * only ever lower a grade.**
 *
 * Without this, the degraded states are the dangerous ones rather than the safe ones — a machine with
 * no evidence would grade on our own repetition count alone and hand back the same confident "A" it
 * gives a term the account has written twenty-four times. Tier A means "the corpus settled this";
 * there is no corpus reading that can be settled by a corpus nobody has refreshed in a month.
 */
export function tierFor(corpus: CorpusStatus, evidence: CorpusEvidence | undefined): CandidateTier {
  if (!corpusIsFresh(corpus) || evidence === undefined) return "B";
  if (evidence.theirs === undefined) {
    // Proper noun. Tier A is available in ONE direction only: the corpus writing the term in English
    // often enough settles `keep`. A zero cannot settle the opposite, because "they transliterate it"
    // and "they have never discussed it" produce the identical zero and only the Korean form — which
    // this signal never learns — tells them apart. That asymmetry is why the 2026-08-11 human graded
    // `World Cup` (월드컵 43 : World Cup 0) as A and this function grades it B: the human had counted
    // 월드컵 by hand.
    return evidence.ours >= TIER_A_MIN_CORPUS ? "A" : "B";
  }
  return evidence.theirs >= TIER_A_MIN_CORPUS && evidence.ours === 0 ? "A" : "B";
}

/** The `--source` string a glossary entry gets, naming what the grade was measured against. */
function sourceLine(corpus: CorpusStatus, evidence: CorpusEvidence | undefined, now: string): string {
  const day = now.slice(0, 10);
  if (corpus.state === "missing") return `참조 코퍼스 없음 — 대조 못 함 (glossary:mine ${day})`;
  const counts =
    evidence === undefined
      ? "대조 못 함"
      : evidence.theirs === undefined
        ? `원문 ${evidence.ours}회`
        : `${evidence.ours}:${evidence.theirs}`;
  if (corpus.state === "undated") return `0xMantleKR 코퍼스 ${counts} (수집 기간 불명, glossary:mine ${day})`;
  const window = `${corpus.coveredFrom.slice(0, 10)}~${corpus.coveredTo.slice(0, 10)}`;
  const stale = corpus.state === "stale" ? `, ${corpus.ageDays}일 지남` : "";
  return `0xMantleKR 코퍼스 ${counts} (${window}${stale})`;
}

function properNounNote(occurrences: number, corpus: CorpusStatus, evidence: CorpusEvidence | undefined): string {
  const mine = `우리 원문 ${occurrences}회.`;
  if (evidence === undefined) return `${mine} 참조 코퍼스가 없어 대조하지 못했습니다 — 표기를 직접 정해 주세요.`;
  if (evidence.ours === 0) {
    return (
      `${mine} 코퍼스에는 원문 표기가 0회 — 계정이 한국어로 옮겨 쓰는 것으로 보입니다. ` +
      `rule과 target을 직접 채워 주세요(코퍼스에서 실제 표기를 확인하시는 게 가장 빠릅니다).`
    );
  }
  const small = evidence.ours < TIER_A_MIN_CORPUS ? " 표본이 작으니 한 번 눈으로 보세요." : "";
  return `${mine} 코퍼스에 원문 그대로 ${evidence.ours}회 — 원문 유지(keep)로 보입니다.${small}`;
}

function substitutionNote(
  draft: string,
  published: string,
  itemIds: string[],
  corpus: CorpusStatus,
  evidence: CorpusEvidence | undefined,
): string {
  const seen = `초안 "${draft}" → 발행 "${published}" · ${itemIds.length}건 (${itemIds.join(", ")}).`;
  if (evidence === undefined) {
    return `${seen} 참조 코퍼스가 없어 대조하지 못했습니다 — 이 교정 자체가 유일한 근거입니다.`;
  }
  const counts = `코퍼스 "${draft}" ${evidence.ours}회 / "${published}" ${evidence.theirs ?? 0}회.`;
  if (evidence.ours === 0 && (evidence.theirs ?? 0) === 0) {
    return `${seen} ${counts} 양쪽 다 0회라 이 교정 ${itemIds.length}건이 유일한 근거입니다.`;
  }
  if (evidence.ours > 0 && (evidence.theirs ?? 0) > 0) {
    return `${seen} ${counts} 코퍼스 자체가 혼용이라, 결정을 박아 두면 그 혼용이 정리됩니다.`;
  }
  return `${seen} ${counts}`;
}

/**
 * Every candidate this week, the ones the corpus threw out, and what the corpus was able to say.
 *
 * Order is tier first (A before B), then corpus evidence, then our own occurrence count, then the key
 * — fully deterministic, because the alert this feeds is read on a phone and a list that reshuffles
 * between two runs that found the same things reads as new information (the reason
 * `overrideNotification` sorts the way it does).
 */
export function mineGlossaryCandidates(input: MiningInput): MiningResult {
  const { sourceTweets, translations, glossary, dismissed, corpusTweets, corpusRuns, now } = input;

  const corpus = gradeCorpus(corpusTweets.length, corpusRuns, now);
  // Joined once. Every count below is a regex over this one string, and building it per candidate
  // turned the real run's ~40 candidates into ~40 passes over the corpus for no gain.
  const corpusProse = corpusTweets.map(proseText).join("\n");
  const haveCorpus = corpus.state !== "missing";
  const count = (form: string): number | undefined => (haveCorpus ? countProse(corpusProse, form) : undefined);

  const dismissedKeys = new Set(dismissed.map((d) => normalizeTerm(d.term)));
  const glossedTerms = new Set(glossary.map((e) => normalizeTerm(e.term)));
  // Both sides of every decision already recorded — a `keep` entry's term and a `translate` entry's
  // target. A substitution that lands on one of these is not an open question.
  const decidedForms = new Set(glossary.flatMap((e) => [normalizeTerm(e.term), normalizeTerm(expectedForm(e))]));

  const candidates: GlossaryCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  // ── Signal 2 + 3, FIRST ──
  //
  // Before signal 1, not after, because a surviving substitution outranks it and has to be able to
  // suppress it. `Turing Test` is the case that forced the ordering: it is an un-glossed proper noun
  // our source repeats (signal 1 → "corpus writes it in English 9 times, keep it") AND a term a human
  // rewrote to 튜링 테스트 before publishing (signal 2 → "transliterate it"). Emitting both puts two
  // opposite recommendations in one review file, and the human's own edit is strictly the better
  // evidence — they had the post in front of them.
  const edits = substitutionEdits(translations);
  const byPair = new Map<string, { draft: string; published: string; itemIds: string[] }>();
  for (const e of edits) {
    const key = `${normalizeTerm(e.draft)} → ${normalizeTerm(e.published)}`;
    const seen = byPair.get(key) ?? { draft: e.draft, published: e.published, itemIds: [] };
    if (!seen.itemIds.includes(e.itemId)) seen.itemIds.push(e.itemId);
    byPair.set(key, seen);
  }
  // Un-glossed proper nouns per item, so a substitution can suggest what its English term is called.
  const sourceTermsByItem = new Map<string, string[]>();
  for (const t of translations) {
    const runs = [...new Set(properNounRuns(t.sourceText))].filter((r) => !glossedTerms.has(normalizeTerm(r)));
    sourceTermsByItem.set(t.itemId, runs.slice(0, 6));
  }

  for (const [, { draft, published, itemIds }] of byPair) {
    const key = `${draft} → ${published}`;
    if (dismissedKeys.has(normalizeTerm(key))) continue;
    // Already decided, in either direction. A human moving AWAY from a decided form is not an open
    // question either — that is exactly `checkPublishedOverrides` (glossaryCompliance.ts), which
    // `translate:check` reports and pages on, and reporting it here too would put the same finding in
    // two weekly alerts that call for opposite responses.
    if (decidedForms.has(normalizeTerm(published)) || decidedForms.has(normalizeTerm(draft))) continue;

    const ours = count(draft);
    const theirs = count(published);
    const evidence: CorpusEvidence | undefined =
      ours === undefined || theirs === undefined ? undefined : { ours, theirs };

    // THE rejection rule. See REJECT_MIN_OURS for the two candidates this threw out on the real run
    // and the one it deliberately kept.
    if (evidence !== undefined && evidence.theirs === 0 && evidence.ours >= REJECT_MIN_OURS) {
      rejected.push({
        key,
        draft,
        published,
        itemIds,
        corpus: evidence,
        reason:
          `코퍼스 "${draft}" ${evidence.ours}회 / "${published}" 0회 — 그 교정은 1회성으로 보이고 ` +
          `우리 초안 쪽이 계정 용례와 같습니다.`,
      });
      continue;
    }

    const tier = tierFor(corpus, evidence);
    candidates.push({
      key,
      signal: "substitution",
      tier,
      // The human's own wording, which IS the answer; what is missing is the English term it answers
      // for, and `sourceTerms` is this module's best offer at that.
      term: published,
      draft,
      published,
      sourceTerms: sourceTermsByItem.get(itemIds[0]) ?? [],
      occurrences: itemIds.length,
      itemIds,
      corpus: evidence,
      rule: "transliterate",
      target: published,
      note: substitutionNote(draft, published, itemIds, corpus, evidence),
      source: sourceLine(corpus, evidence, now),
    });
  }

  // Terms a surviving substitution has already spoken for — see the ordering comment above. A
  // REJECTED substitution deliberately does not land here: rejecting `X → 한국어` means the corpus
  // sided with our draft, i.e. with keeping `X`, which is the same answer signal 1 would give, so
  // there is no contradiction to suppress and the proper-noun candidate is still worth proposing.
  const spokenFor = new Set(candidates.filter((c) => c.signal === "substitution").map((c) => normalizeTerm(c.draft!)));

  // ── Signal 1 ──
  const properNounCounts = new Map<string, number>();
  for (const tweet of sourceTweets) {
    for (const run of properNounRuns(tweet)) properNounCounts.set(run, (properNounCounts.get(run) ?? 0) + 1);
  }
  for (const [term, occurrences] of properNounCounts) {
    if (occurrences < MIN_PROPER_NOUN_OCCURRENCES) continue;
    const key = normalizeTerm(term);
    if (glossedTerms.has(key)) continue;
    if (dismissedKeys.has(key)) continue;
    if (spokenFor.has(key)) continue;

    const ours = count(term);
    const evidence: CorpusEvidence | undefined = ours === undefined ? undefined : { ours };
    candidates.push({
      key: term,
      signal: "proper-noun",
      tier: tierFor(corpus, evidence),
      term,
      occurrences,
      corpus: evidence,
      // Only proposed when the corpus actually supports keeping it. A blank rule is a question for a
      // human, and a question is a better review file than a guess they have to notice and undo.
      rule: evidence !== undefined && evidence.ours > 0 ? "keep" : undefined,
      note: properNounNote(occurrences, corpus, evidence),
      source: sourceLine(corpus, evidence, now),
    });
  }

  const strength = (c: GlossaryCandidate): number =>
    c.corpus === undefined ? 0 : c.corpus.theirs === undefined ? c.corpus.ours : c.corpus.theirs;
  candidates.sort(
    (a, b) =>
      a.tier.localeCompare(b.tier) ||
      strength(b) - strength(a) ||
      b.occurrences - a.occurrences ||
      a.key.localeCompare(b.key),
  );
  rejected.sort((a, b) => b.corpus.ours - a.corpus.ours || a.key.localeCompare(b.key));

  return { candidates, rejected, corpus };
}
