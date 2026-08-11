import type { ContentItem } from "../translation/contentItem";
import type { FewShotExample } from "../translation/models";
import { anchorSimilarity, extractAnchors } from "./anchors";
import { lexicalSimilarity } from "./lexical";

const LEXICAL_MIN_SIMILARITY = 0.2;

/**
 * The `k` TM pairs whose anchors best match `targetAnchors`, strongest first.
 *
 * Ranked by **proportion of overlap** (`anchorSimilarity`, Jaccard), not by the raw count of shared
 * anchors — see that function for the corpus measurement that forced the change. A candidate sharing
 * 3 of its 4 anchors is a better precedent than one sharing 3 of its 62.
 *
 * The `> 0` filter is unchanged in *meaning*: Jaccard is positive exactly when at least one anchor is
 * shared, so this admits and rejects precisely the candidates the raw count did and only reorders
 * what survives. That equivalence is load-bearing for `selectPrecedents` below — its lexical fallback
 * keys off `anchorPicks.length`, which therefore cannot move. Measured over the 26 recorded
 * translations against the live tm.json: the fallback branch is entered for 15 of them before and
 * after, attaching 0 precedents in both cases (every remaining pair scores under
 * `LEXICAL_MIN_SIMILARITY`).
 *
 * The two Jaccards are **not on one scale** and are never compared with each other: an anchor score
 * of 0.33 is two shared tickers out of six, a lexical 0.33 is a third of the content words. Anchors
 * fill first; lexical only fills the slots they left.
 */
function selectByAnchors(targetAnchors: string[], tm: FewShotExample[], k: number): FewShotExample[] {
  return tm
    .map((ex) => ({ ex, score: anchorSimilarity(extractAnchors(ex.source), targetAnchors) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k)
    .map((s) => s.ex);
}

/**
 * TM pairs to inline in the translation prompt for a whole batch, scored against the **union** of the
 * batch's anchors — one prompt serves every item in it, so there is one target set, not one per item.
 *
 * That union is also the limit of what normalizing buys this caller, and the honest measurement is
 * worth writing down: the union grows with the batch, and it sits on Jaccard's denominator for every
 * candidate alike, so a wide batch dilutes the penalty a bloated pair pays. On the real corpus of
 * 2026-08-11 a `translate:prepare` default batch (20 pending items, 41 distinct anchors) selects the
 * identical six pairs before and after — 39,198자 of TM either way, the 22,976자 recap still first,
 * because against 41 target anchors it genuinely does cover the most. Shrink the batch and the effect
 * appears: 5 items (6 anchors) go 32,636자 → 15,524자, a single two-anchor item 17,379자 → 13,046자.
 * So this is a real but batch-size-dependent improvement here, and a decisive one for
 * `selectPrecedents`, which always scores against a single draft.
 */
export function selectRelevantTm(batch: ContentItem[], tm: FewShotExample[], k: number): FewShotExample[] {
  const batchAnchors = [...new Set(batch.flatMap((i) => extractAnchors(i.text)))];
  return selectByAnchors(batchAnchors, tm, k);
}

export function selectPrecedents(sourceText: string, tm: FewShotExample[], k: number): FewShotExample[] {
  const anchorPicks = selectByAnchors(extractAnchors(sourceText), tm, k);
  if (anchorPicks.length >= k) return anchorPicks;

  const chosen = new Set(anchorPicks); // identity-based: the same objects live in `tm`
  const lexicalPicks = tm
    .filter((ex) => !chosen.has(ex))
    .map((ex) => ({ ex, score: lexicalSimilarity(sourceText, ex.source) }))
    .filter((s) => s.score >= LEXICAL_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k - anchorPicks.length)
    .map((s) => s.ex);

  return [...anchorPicks, ...lexicalPicks];
}
