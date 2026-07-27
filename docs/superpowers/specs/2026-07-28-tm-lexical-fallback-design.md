# TM alignment — lexical-similarity fallback for anchorless drafts — design

Date: 2026-07-28
Status: approved for planning
Scope: extend the alignment pass's precedent selection so drafts with **no shared anchors** (e.g. an
announcement with no cashtag/hashtag/mention) still get nearest-precedent EN↔KO pairs, by falling
back to English-source **lexical similarity**. Domain-only; the deferred next slice of PR #58.

## Context

The alignment pass (`translate:align`, PR #58) selects precedent pairs by **anchor overlap**:
`selectPrecedents(sourceText, tm, k)` = `selectByAnchors(extractAnchors(sourceText), tm, k)`, where
anchors are cashtags/hashtags/mentions (they survive translation, so they tie an EN post to its KO
translation). Anchors are a **high-precision** signal for proper nouns and campaigns — exactly where
precedent phrasing matters most. But a draft with **no anchors** (a plain announcement, "gm"-style
copy) gets **zero** precedents and is skipped, so the align pass — the project's one quality lever on
translations — never fires on that content.

The fill: when anchors don't supply `k` precedents, rank the remaining TM pairs by **lexical
similarity** on the English source and use the strongest ones. This keeps anchors first (their
precision is unchanged) and only extends coverage to anchorless drafts. It is deliberately simple —
token overlap, no ML/embeddings — under the zod-only constraint.

## Decisions

### 1. Anchor-first, lexical-fill inside `selectPrecedents` (signature unchanged)

`selectPrecedents(sourceText, tm, k)` becomes:

1. `anchorPicks = selectByAnchors(extractAnchors(sourceText), tm, k)` (unchanged behavior).
2. If `anchorPicks.length >= k`, return them (anchored drafts are unaffected).
3. Otherwise fill the remaining `k - anchorPicks.length` slots from the TM pairs **not already
   picked**, ranked by `lexicalSimilarity(sourceText, ex.source)` descending, keeping only those at
   or above the threshold (Decision 3).
4. Return `[...anchorPicks, ...lexicalPicks]` — anchor precedents first, lexical fills after.

The caller (`PrepareAlignment`, `PRECEDENTS_PER_DRAFT = 3`) is untouched — the signature and return
type are identical. `selectRelevantTm` (the batch-prompt TM inlining) stays anchor-only; extending it
is a separate later slice (Non-goals).

### 2. `lexicalSimilarity` — Jaccard over content tokens (zod-only, no dependency)

`lexicalSimilarity(a: string, b: string): number` in `[0, 1]`:

- Tokenize each English text: lowercase, split on non-word characters, then **drop tokens ≤ 2
  characters and a small English stopword set** (the/a/an/is/are/of/to/on/in/for/and/with/… — the
  function words that would otherwise inflate overlap). The remaining **content tokens** carry the
  topic (tokenized/stocks/liquidity/mantle/trade/…).
- Similarity = **Jaccard** = `|A ∩ B| / |A ∪ B|` over the two token **sets**. Jaccard penalizes
  length mismatch, so a short generic post does not spuriously match a long unrelated one — the
  conservative choice for "same topic" rather than "shares a few words".
- Both sides empty (no content tokens) → `0` (not a match; never divide by zero).

### 3. A minimum-similarity threshold — skip a weak fill rather than attach it

`LEXICAL_MIN_SIMILARITY` (starting at **0.2**, a module constant, tuned on real data): a lexical
precedent is attached only if its similarity is **≥ threshold**. Below it, the slot stays **empty**
and — if the draft has no anchors either — the draft is still **skipped by the align pass** (its
existing behavior for a precedentless draft). The guiding rule: an unrelated "nearest" precedent
pulls the alignment the wrong way, so **when in doubt, attach nothing** (the same lesson as PR #52's
shoutout-thread over-match). Better coverage must not cost precision.

### 4. Scope: `selectPrecedents` only; pure domain; no caller/CLI/adapter change

- New pure module `src/domain/tm/lexical.ts` (tokenize + `lexicalSimilarity`).
- `src/domain/tm/selection.ts` extends `selectPrecedents` to compose anchor picks + lexical fill;
  `selectByAnchors`/`selectRelevantTm` are unchanged.
- Nothing else changes: `translate:align` / `PrepareAlignment` already call `selectPrecedents`.

## Architecture

- **Domain:** `src/domain/tm/lexical.ts` — `tokenize(text): string[]` (lowercase, split, drop
  stopwords + ≤2-char), `lexicalSimilarity(a, b): number` (Jaccard over token sets). `LEXICAL_STOPWORDS`
  a small `Set<string>`.
- **Domain:** `src/domain/tm/selection.ts` — `selectPrecedents` gains the lexical-fill branch and a
  `LEXICAL_MIN_SIMILARITY` constant; imports `lexicalSimilarity`.
- **Reuse:** `selectByAnchors`, `extractAnchors` (unchanged); `FewShotExample`.
- **Tests:** `tests/domain/tm/lexical.test.ts`, and lexical-fill cases added to
  `tests/domain/tm/selection.test.ts`.

### Data flow

```
selectPrecedents(sourceText, tm, k=3)
  anchorPicks = selectByAnchors(extractAnchors(sourceText), tm, k)   # e.g. 0 for an anchorless 공지
  if anchorPicks.length >= k: return anchorPicks
  remaining = tm minus anchorPicks
  lexicalPicks = remaining
      .map(ex => ({ ex, s: lexicalSimilarity(sourceText, ex.source) }))
      .filter(s >= LEXICAL_MIN_SIMILARITY)
      .sort(desc).slice(0, k - anchorPicks.length).map(ex)
  return [...anchorPicks, ...lexicalPicks]
```

## Error handling / edge cases

- **Empty `tm`** → `[]` (both branches yield nothing).
- **Draft with no content tokens** (e.g. only emojis/handles after stopword strip) → every
  `lexicalSimilarity` is `0`, all below threshold → no lexical fill (draft skipped if also anchorless).
- **A pair already chosen by anchors** is excluded from the lexical candidate set (no duplicate in the
  returned list).
- **Ties in lexical score** keep input order (stable V8 sort), matching `selectByAnchors`.
- Purely in-memory; no I/O, no network.

## Testing

- `lexicalSimilarity`: identical text → `1`; disjoint content → `0`; a known partial overlap → the
  exact Jaccard value; stopwords and ≤2-char tokens are dropped (two texts differing only in
  stopwords score `1`); two empty-after-strip texts → `0`. Pin exact numbers.
- `selectPrecedents`:
  - an **anchored** draft returns the anchor picks unchanged (lexical never consulted when anchors
    fill `k`);
  - an **anchorless** draft with a TM pair whose English source is lexically similar above threshold
    returns that pair; below threshold returns **nothing**;
  - **anchor + fill**: anchors supply 1 of k=3, lexical fills the other 2 from the most-similar
    remaining pairs, anchors first, no duplicate of the anchor pick;
  - ties/order and the empty-tm case.
  - Every assertion pins concrete pair sources / counts.
- All synthetic TM pairs; no live call.

## Non-goals

- **Semantic/embedding similarity or ML** — token Jaccard only (zod-only).
- **TF-IDF / corpus-weighted scoring** — no cross-pair statistics; per-pair token overlap only.
- **Extending `selectRelevantTm`** (the batch translation prompt) to lexical — align pass only.
- **Re-tuning anchor precision** or changing `extractAnchors`.
- **Multilingual/Korean-side similarity** — matching is on the **English** source (the shared
  language between a draft and a precedent's `source`).

## Global constraints

- Runtime deps stay **zod-only**; no dependency, no network — pure string/set math.
- Anchor behavior is **unchanged**: anchored drafts get exactly today's precedents; lexical only fills
  slots anchors left empty, and only above the threshold.
- `selectPrecedents`'s signature and return type are unchanged (`PrepareAlignment` untouched).
- Better coverage never costs precision: a sub-threshold lexical match is dropped, not attached.
- Public repo: tests use synthetic English/Korean strings only; no real post text.
- Every test can fail: pin exact Jaccard values, pair sources, and counts.

## Open items to verify (not blockers to planning)

- On the real pending drafts + `tm.json`, confirm `LEXICAL_MIN_SIMILARITY = 0.2` attaches sensible
  precedents to anchorless 공지 without pulling in unrelated ones — tune the constant if it is too
  permissive (junk fills) or too strict (still skipping obviously-similar drafts).
- Confirm the stopword set is not so aggressive that it strips the crypto content tokens that carry
  the topic (it should drop only generic English function words).
