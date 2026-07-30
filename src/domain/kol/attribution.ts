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
// Emoji and other symbol/pictograph codepoints, stripped so they cannot
// contribute to (or dilute) the 3-gram set.
const EMOJI_PATTERN = /\p{Extended_Pictographic}/gu;
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
