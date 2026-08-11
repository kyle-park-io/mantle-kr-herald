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

/**
 * How much two anchor sets overlap, as **Jaccard** — `|shared| / |union|` — in [0, 1].
 *
 * Exists because ranking TM candidates by the *raw* shared count structurally favours long posts: a
 * long post names more projects and tickers, so it shares an anchor with almost anything. Measured
 * against the ten pairs in the live `translation/tm.json` on 2026-08-11, anchor count tracks pair
 * size almost perfectly — 62 anchors/22,976자, 47/4,939, 30/2,291, 19/2,461, … 2/581 — and the
 * 62-anchor pair is a **monthly recap thread** (a lede plus fifteen numbered project blurbs). Under
 * raw count it was a precedent for 8 of the 14 recorded drafts that share any anchor at all; under
 * Jaccard, 5. That matters most to the alignment pass, whose entire instruction is "match the
 * phrasing and terminology of the 선례" (`ALIGNMENT_TASK`): a recap's register is the wrong thing to
 * teach an ordinary post. On the one alignment-eligible draft of 2026-08-11
 * (`x:2087156149368082696`, six anchors) the switch cut its precedent block from 28,521자 to 2,369자
 * and dropped the recap out of it entirely.
 *
 * **Jaccard rather than `|shared| / |candidate anchors|`.** That bare coverage ratio removes the bias
 * by mirroring it: it scores a 1-of-1 match at 1.0 and an 8-of-10 match at 0.8, so the least
 * informative pair in the corpus wins. Dividing by the *union* charges the bloated candidate for
 * everything it does not share while still paying a candidate that covers much of the target.
 *
 * **And it is the measure this codebase already uses for this class of question**, three times over
 * now: `lexicalSimilarity` (the sibling module `selectPrecedents` falls back to) is Jaccard over
 * content-token sets, and `kol/attribution.ts`'s `similarity` — what `publish/xReconcile.ts` bands
 * its verdicts on — is Jaccard over character 3-grams. Different token sets, one measure.
 *
 * Both arguments must already be **deduplicated**, which is what `extractAnchors` returns (it builds
 * from a `Set`) and what `selectRelevantTm` spreads for a batch: the union is computed as
 * `|a| + |b| - |shared|`, so a repeated anchor would inflate it and quietly depress the score.
 *
 * Returns 0 — never NaN — when either side is empty, since `shared` is then 0 and the early return
 * fires before the division.
 */
export function anchorSimilarity(a: string[], b: string[]): number {
  const shared = sharedAnchors(a, b).length;
  if (shared === 0) return 0;
  return shared / (a.length + b.length - shared);
}
