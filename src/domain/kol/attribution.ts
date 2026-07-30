/**
 * Attribute a KOL's public post to one of our approved pieces of copy.
 *
 * This is a *suggestion*, never authoritative: it pre-fills an item id and topic
 * in the review tab so a human doesn't have to type them for every KOL who ran
 * the same campaign, but a human always confirms or overrides the guess.
 *
 * Pure module: no clock, no I/O, no state.
 */

export interface MatchCandidate {
  itemId: string;
  text: string;
}

export interface MatchResult {
  itemId: string;
  score: number;
}

/**
 * Minimum Jaccard similarity for a candidate to be surfaced as a match.
 *
 * This is an initial value, not a tuned one: no renderings exist before
 * 2026-07-21, so there is no historical data to calibrate against. Revisit
 * once the first real August sweep gives us KOL posts to measure against.
 */
export const MATCH_THRESHOLD = 0.3;

const URL_PATTERN = /https?:\/\/\S+/gu;
/**
 * Emoji, stripped whole so they cannot contribute to (or dilute) the 3-gram set.
 *
 * `\p{Extended_Pictographic}` alone removed only the pictograph itself and left the codepoints that
 * glue a sequence together behind: U+FE0F (variation selector), U+200D (ZWJ), and the U+1F3FB-1F3FF
 * skin-tone modifiers. Each survivor is an invisible character sitting in the middle of the
 * normalized string, and at 3-grams one stray codepoint corrupts up to three of them — so the same
 * sentence scored differently depending on which emoji a KOL happened to decorate it with. Fixed
 * *before* anyone calibrates `MATCH_THRESHOLD` on a real August run, since calibrating first would
 * have baked the residue into the constant.
 *
 * Regional indicators are included: they are the halves of a flag, meaningless as text on their own.
 * So is U+20E3 (COMBINING ENCLOSING KEYCAP), which none of the three properties above covers —
 * `"1️⃣"` normalized to `"1⃣"`, losing the variation selector and keeping the keycap mark. KOL promo
 * copy numbers its lists with these (`1️⃣ 첫번째`, `2️⃣ 두번째`), so it is a real shape of input. Note
 * this does not reopen the digit problem below: U+20E3 is only the combining decoration, never the
 * `1`, `#`, or `*` it encloses, so the digit itself still survives normalization.
 *
 * `\p{Emoji_Component}` is deliberately **not** used, despite covering exactly these codepoints. It
 * also matches ASCII `0`-`9`, `#`, and `*` (verified: `/\p{Emoji_Component}/u.test("7") === true`),
 * because those are the bases of keycap emoji. Stripping every digit would make "100 MNT" and
 * "200 MNT" normalize identically and delete `#` from every hashtag — inflating similarity between
 * posts that differ precisely in their numbers. A false positive is the expensive direction here
 * (see §4 of the design): it plants a wrong topic that inheritance then spreads to every row sharing
 * the itemId, and re-running cannot repair it.
 */
const EMOJI_PATTERN =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;
const WHITESPACE_PATTERN = /\s+/gu;

/**
 * Normalize text for matching: strip URLs, then emoji, then all whitespace,
 * then lowercase. Order matters — stripping whitespace before URLs would
 * weld a URL to its neighbouring word instead of removing it cleanly.
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(URL_PATTERN, "")
    .replace(EMOJI_PATTERN, "")
    .replace(WHITESPACE_PATTERN, "")
    .toLowerCase();
}

/** The set of character 3-grams of a string, deduplicated. */
function trigrams(normalized: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    grams.add(normalized.slice(i, i + 3));
  }
  return grams;
}

/**
 * Jaccard similarity over the sets of character 3-grams of the normalized
 * inputs: |A ∩ B| / |A ∪ B|. A set measure — not an edit-distance ratio — so
 * that a KOL reordering our sentences still scores highly.
 *
 * Returns 0 (never NaN) whenever either side normalizes to fewer than 3
 * characters, since that yields an empty 3-gram set.
 */
export function similarity(a: string, b: string): number {
  const normA = normalizeForMatch(a);
  const normB = normalizeForMatch(b);

  if (normA.length < 3 || normB.length < 3) return 0;

  const gramsA = trigrams(normA);
  const gramsB = trigrams(normB);

  let intersectionSize = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersectionSize++;
  }

  const unionSize = gramsA.size + gramsB.size - intersectionSize;
  if (unionSize === 0) return 0;

  return intersectionSize / unionSize;
}

/**
 * Score every candidate against `text` and return the best one, provided its
 * score clears MATCH_THRESHOLD. Ties resolve to the first candidate in input
 * order, so re-running attribution over the same rows cannot silently
 * re-attribute it to a different item.
 */
export function bestMatch(text: string, candidates: MatchCandidate[]): MatchResult | undefined {
  let best: MatchResult | undefined;

  for (const candidate of candidates) {
    const score = similarity(text, candidate.text);
    if (best === undefined || score > best.score) {
      best = { itemId: candidate.itemId, score };
    }
  }

  if (best === undefined || best.score < MATCH_THRESHOLD) return undefined;

  return best;
}
