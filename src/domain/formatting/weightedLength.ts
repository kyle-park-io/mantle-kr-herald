/**
 * X counts characters by weight, not by code point. twitter-text v3 gives every code point
 * outside these ranges the default weight of 200, so a Hangul syllable costs 2 and a pure-Korean
 * post maxes out at 140 characters — not 280. Counting code points (the old behaviour) meant a
 * Korean post between 141 and 280 characters was over the real limit with no warning.
 * https://docs.x.com/fundamentals/counting-characters
 * https://github.com/twitter/twitter-text/blob/master/config/v3.json
 */
const WEIGHT_100_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const SCALE = 100;
const DEFAULT_WEIGHT = 200;

/** Every URL is wrapped by t.co and costs this much, whatever its real length or scheme. */
export const TCO_LENGTH = 23;

/** Weighted units available in one post on a free account. */
export const X_MAX_WEIGHTED = 280;

const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * Sentence-ending punctuation and quotes that commonly trail a URL in prose but are never part
 * of the URL itself — unlike brackets (see `BALANCED_DELIMITERS`), these are trimmed
 * unconditionally.
 */
const TRAILING_PUNCTUATION = /[.,!?;:'"]/;

/**
 * Closing delimiters that trail a URL in prose (e.g. a link wrapped in parens) but can also be
 * genuinely part of the URL (e.g. a Wikipedia slug like "Mantle_(blockchain)"). Paired with the
 * opener that, if it appears earlier in the same matched URL, means the closer belongs there too.
 */
const BALANCED_DELIMITERS: readonly (readonly [open: string, close: string])[] = [
  ["(", ")"],
  ["[", "]"],
];

function countOccurrences(str: string, ch: string): number {
  let count = 0;
  for (const c of str) if (c === ch) count++;
  return count;
}

/**
 * Strips punctuation that trails a matched URL but isn't really part of it. Sentence-ending
 * punctuation and quotes always go. A closing bracket only goes if it doesn't balance an opening
 * bracket found earlier in the same URL — so the genuine closing paren in
 * "https://en.wikipedia.org/wiki/Mantle_(blockchain)" is kept, while an outer wrapping paren
 * added by surrounding prose is not. Repeats until nothing more should come off.
 */
function trimTrailingPunctuation(url: string): string {
  let result = url;
  while (result.length > 0) {
    const last = result[result.length - 1];
    const bracket = BALANCED_DELIMITERS.find(([, close]) => close === last);
    if (bracket) {
      const [open, close] = bracket;
      if (countOccurrences(result, close) > countOccurrences(result, open)) {
        result = result.slice(0, -1);
        continue;
      }
      break;
    }
    if (TRAILING_PUNCTUATION.test(last)) {
      result = result.slice(0, -1);
      continue;
    }
    break;
  }
  return result;
}

function weightOf(codePoint: number): number {
  for (const [start, end] of WEIGHT_100_RANGES) {
    if (codePoint >= start && codePoint <= end) return SCALE;
  }
  return DEFAULT_WEIGHT;
}

/**
 * X's weighted length of `text`.
 *
 * Known limitation: twitter-text's real extractor also treats scheme-less hosts ("example.com")
 * as URLs, which this regex misses and therefore under-counts. Canonical text writes links as
 * [text](url) with an explicit scheme, so this is acceptable — pull in the `twitter-text` package
 * if that ever stops being true. Two URLs with no separator between them (e.g.
 * "https://a.com" immediately followed by "https://b.com") are also counted as a single URL;
 * this is likewise an accepted gap, since real-world URL extractors are ambiguous about it too.
 */
export function weightedLength(text: string): number {
  const normalised = text.normalize("NFC");
  let total = 0;
  let plain = "";
  let cursor = 0;
  for (const match of normalised.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const trimmed = trimTrailingPunctuation(match[0]);
    plain += normalised.slice(cursor, start);
    total += TCO_LENGTH * SCALE;
    cursor = start + trimmed.length;
  }
  plain += normalised.slice(cursor);
  for (const ch of plain) total += weightOf(ch.codePointAt(0)!);
  return total / SCALE;
}
