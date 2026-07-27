// Tokens that survive translation intact, so they anchor an EN post to its KO translation.
//  URLs are deliberately excluded: tweet text carries per-share t.co links that differ between
//  the two posts, so they never match. Cashtags/hashtags/mentions are copied verbatim.
const CASHTAG = /\$[A-Za-z][A-Za-z0-9_]*/g;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const MENTION = /@[A-Za-z0-9_]{1,15}/g;

export function extractAnchors(text: string): string[] {
  const found = new Set<string>();
  for (const re of [CASHTAG, HASHTAG, MENTION]) {
    for (const m of text.matchAll(re)) found.add(m[0].toLowerCase());
  }
  return [...found];
}

export function sharedAnchors(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}
