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

const URL = /https?:\/\/\S+/g;

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
 * if that ever stops being true.
 */
export function weightedLength(text: string): number {
  const normalised = text.normalize("NFC");
  let total = 0;
  let plain = "";
  let cursor = 0;
  for (const match of normalised.matchAll(URL)) {
    const start = match.index ?? 0;
    plain += normalised.slice(cursor, start);
    total += TCO_LENGTH * SCALE;
    cursor = start + match[0].length;
  }
  plain += normalised.slice(cursor);
  for (const ch of plain) total += weightOf(ch.codePointAt(0)!);
  return total / SCALE;
}
