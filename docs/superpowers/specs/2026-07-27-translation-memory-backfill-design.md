# Translation memory — reference-account backfill — design

Date: 2026-07-27
Status: approved for planning
Slice: **engine + few-shot backfill** (the first of two consumers; the per-item align pass is a
separate follow-up slice — see Non-goals).

## Context

### The gap this closes

The translation few-shot corpus is tiny (10 hand-curated entries, ~415 chars each) and grows only
from translations approved *inside this tool* (`SaveTranslation` promotes an approved item into
`translation/few-shot.json`). Meanwhile the team's Korean X account **@0xMantleKR** holds hundreds
of real, already-published, team-approved Korean renderings — and none of them enter the pipeline.
That is the single richest body of translation guidance available, and today it is unused.

### The reframe: this is a translation memory, not a style reference

@0xMantleKR posts **Korean translations of Mantle_Official's English posts**. So the two accounts
form real **EN→KO pairs**: for a Mantle_Official English post there is (often) a @0xMantleKR Korean
post that is its published translation. Reusing those past renderings is exactly a **translation
memory (TM)** — "when the team translated English like this before, they rendered it like this."
This is far stronger signal than a hand-written style example because it is the team's own approved
output.

### What this slice delivers, and what it defers

The pairing engine (collect @0xMantleKR + match EN↔KO) is a **shared foundation** with two
independent consumers:

- **(A) few-shot backfill** — mined pairs feed the translation prompt, lifting the first-draft
  quality of *every* translation. **This slice.**
- **(B) align pass** — a per-item correction stage that pulls the nearest precedent pairs for a
  fresh item and revises its draft before 1차 review. **Deferred to a follow-up slice** that reuses
  this slice's engine + relevance selection.

We build A first because it validates the pairing precision on real data before a whole stage is
layered on top, it lifts every translation upstream (so B later has less to fix), and it is the
cheaper build (no new review stage — it fills the existing prompt path).

## Decisions

### 1. The reference account is collected by the existing engine into an isolated store

@0xMantleKR is fetched with the same `CollectAuthoredContent` use case and
`TwitterApiSourceGateway` as Mantle_Official, but wired to **separate store paths**
(`output/x/reference/{items,state,runs}.json`). `XContentSource` is **not** pointed at the reference
store, so a Korean post can never enter the translation queue. This reuses collection wholesale —
threads, watermark, coverage ledger, pagination cap — for free.

Config: `REFERENCE_X_HANDLE` (default `0xMantleKR`). The default is documented so a fresh checkout
works; the env var lets it change without code edits.

### 2. Volume is measured first, then collected incrementally — never a blind unbounded fetch

We do not know how many posts @0xMantleKR has, and twitterapi.io is billed. So:

- `tm:measure` reads the account's profile in **one call** and reports `statuses_count` plus an
  estimated page count / API-call cost for a full backfill. The operator sees the number **before**
  committing to full history.
- Reference collection reuses the X **watermark** (`output/x/reference/state.json`) and **coverage
  ledger** (`runs.json`), so "full history" means "run until caught up," reached in bounded,
  resumable increments (`--since`/`--limit`, `MAX_PAGES` cap). A run that is interrupted resumes;
  a re-run does not re-fetch.
- **Target = full history** (more precedents ⇒ better retrieval; the selection step only inlines K,
  so a large corpus never bloats the prompt). If the measured volume is too large to be worth it,
  the same mechanism narrows to a recent window instead.

### 3. Pairing = code-generated candidates → human confirmation → promote (precision first)

A wrong pair poisons few-shot, and few-shot outweighs prose rules in the prompt, so **precision beats
recall**. The flow mirrors the existing invariant "nothing enters few-shot without human approval":

- **Candidate generation (code, deterministic).** For each Korean thread (a reference
  `ContentItem`-equivalent root), find candidate English threads from `output/x/items.json` where:
  - **temporal:** the English post precedes the Korean post within a window
    (`0 ≤ KO.createdAt − EN.createdAt ≤ PAIR_WINDOW_DAYS`, default 14) — translation follows source;
  - **anchor overlap:** the two share language-surviving anchors. Score = count of shared anchors.
- **Anchors** (extracted by a pure `extractAnchors(text)`): cashtags (`$MNT`), hashtags (`#Mantle`),
  `@mentions`, and expanded/display URLs from tweet entities when available. These survive
  translation intact. (Numeric/date tokens are noisier and are out of scope for v1 — added later if
  precision headroom allows.)
- Keep only candidates at or above `PAIR_MIN_ANCHORS` (default 2) and take the top-scoring English
  match per Korean post.
- **Human confirmation.** `tm:pair` writes a **review worksheet** (proposed pairs: EN text ↔ KO
  text, score, shared anchors, dates). The operator deletes wrong pairs. `tm:promote` reads the
  survivors and writes them to the TM store. No pair is ever auto-promoted.
- **One-time backfill** is a bounded review session; ongoing (as @0xMantleKR translates new posts)
  is a trickle handled by the same three commands.

### 4. TM is a second few-shot corpus; the curated few-shot stays separate and sacred

Confirmed pairs go to **`translation/tm.json`** — a second corpus with the same `FewShotExample`
shape (`{source, target, itemId?}`), reusing `JsonFewShotStore` pointed at a different file. It is
**not** merged into `translation/few-shot.json` because:

- the curated few-shot is a small, hand-tuned set of style anchors that must stay clean and
  **always** be included;
- TM is large and must be **uncapped** in source length (real threads/announcements run long — the
  2000-char guard on curated few-shot would exclude exactly the substantial examples TM is for).

Distribution follows the same rule as the other steering files (`.example` tracked, the real
`tm.json` git-ignored and shared out of band). Its size strengthens the already-noted case for a
`config:push`/`pull` over Drive; that remains out of scope here.

### 5. Inlining is upgraded from "last 8" to "curated + top-K relevant TM" — this is what makes the backfill pay off

`PrepareTranslations` currently inlines `fewShots.slice(-MAX_FEW_SHOTS)` — the last 8 by recency.
Pouring 200 TM pairs into a store the prompt reads "last 8" from would waste them. So the selection
becomes:

```
inlined few-shots = curated few-shot (unchanged behaviour)  +  top-K TM pairs by relevance to THIS batch
```

The curated selection keeps its current rule (recency cap `MAX_FEW_SHOTS`); TM is an **additive**
budget on top, never displacing a curated example — the two corpora have disjoint budgets so TM can
never crowd out a hand-tuned anchor.

- **Relevance is same-language.** Score each TM pair by anchor/keyword overlap between its **English
  source** and the union of the current batch's **English item** anchors/keywords — English-to-
  English, which is far more reliable than matching across languages. Ties break by recency.
- Selection is **per batch** (the shared context, few-shots included, is assembled once per batch in
  `assembleSharedContext` — not per item). Per-item selection is a bigger change and belongs to the
  align-pass slice (B).
- A budget caps total inlined TM (default `MAX_TM_FEW_SHOTS`, e.g. 6) so the prompt stays bounded.

The relevance function is a pure, testable domain function and is **the reusable core the align pass
(B) will consume later**.

## Architecture

New (all additive; existing translate path unchanged except the one selection call):

- **Reference collection** — a `collect:reference` CLI wiring `CollectAuthoredContent` to
  reference store paths + `REFERENCE_X_HANDLE`. No new use case.
- **`tm:measure` CLI** — one profile lookup → volume/cost report. A small
  `SourceGateway.fetchUserProfile`-style read (or reuse whatever the gateway already exposes for a
  user's `statuses_count`; add a thin method only if none exists).
- **Domain (pure, tested in isolation):**
  - `src/domain/tm/anchors.ts` — `extractAnchors(text): Anchors`.
  - `src/domain/tm/pairing.ts` — `scorePair(en, ko)`, `proposePairs(enRoots, koRoots, opts)`.
  - `src/domain/tm/selection.ts` — `selectRelevantTm(batchItems, tmPairs, k): FewShotExample[]`.
- **`tm:pair` / `tm:promote` CLIs** — worksheet out, confirmed pairs in.
- **Stores:** `output/x/reference/{items,state,runs}.json` (new paths in `src/paths.ts`);
  `translation/tm.json` + `translation/tm.example.json`.
- **Changed:** `PrepareTranslations` — load the TM store, replace `fewShots.slice(-8)` with
  `[...curatedFewShots, ...selectRelevantTm(pending, tm, MAX_TM_FEW_SHOTS)]`. One new constructor
  dependency (the TM store); `translate:prepare` passes a second `JsonFewShotStore` at
  `translation/tm.json`.

### Data flow

```
collect (Mantle_Official)  → output/x/items.json ─────────────┐
collect:reference (0xMantleKR) → output/x/reference/items.json ┤
                                                               ▼
                                        tm:pair  (anchors + temporal window)
                                                               │  proposed pairs → review worksheet
                                                    human deletes wrong pairs
                                                               ▼
                                        tm:promote → translation/tm.json
                                                               │
translate:prepare ─ load curated few-shot + tm.json ───────────┤
                    selectRelevantTm(batch, tm, K)             ▼
                    assembleSharedContext(... curated + top-K TM ...) → worksheet
```

## Error handling

- `tm:measure` and `collect:reference` surface API errors via the existing `registerErrorHandler`
  `✖ <msg>` + exit 1 path.
- A reference account with no posts, or a batch with no anchor matches, is not an error: `tm:pair`
  proposes nothing; `selectRelevantTm` returns `[]` and translation proceeds on curated few-shot
  only (exactly today's behaviour). The feature degrades to the current state, never worse.
- `tm:promote` on a worksheet with every pair deleted writes nothing and says so.

## Testing

- `extractAnchors` — cashtags/hashtags/mentions/urls extracted; empties and duplicates handled.
- `scorePair` / `proposePairs` — a true pair scores above the threshold; a same-day unrelated pair
  sharing only `$MNT` stays below `PAIR_MIN_ANCHORS`; a KO post *before* its EN post is rejected by
  the temporal guard; the top English match is chosen among several candidates.
- `selectRelevantTm` — curated few-shots always present; the TM pair sharing the most anchors with
  the batch ranks first; K caps the count; recency breaks ties; empty TM ⇒ curated only.
- `PrepareTranslations` — the worksheet contains curated few-shots + the relevant TM pairs and not
  irrelevant ones; unchanged when `tm.json` is absent/empty.
- Each threshold/branch is pinned so no test is vacuously green (the recurring "test that cannot
  fail" defect from prior slices — mutation-check each assertion).

## Non-goals

- **The align pass (B)** — the per-item correction stage between translate and 1차. Next slice.
- **Auto-promotion without human review** — precision-critical; never.
- **Per-item few-shot selection** — this slice selects per batch; per-item is B's job.
- **Cross-language semantic matching / embeddings** — anchors + same-language keyword overlap only
  (zod-only, local, no vector infra).
- **Telegram/Kakao reference accounts** — X only.
- **Articles** — deprioritized by the user; TM pairs are ordinary posts/threads for v1.

## Open items to verify live (not blockers to planning)

- Measure @0xMantleKR volume with `tm:measure` before the first full backfill; confirm the cost is
  acceptable or narrow the window.
- Inspect the first `tm:pair` worksheet on real data to confirm anchor+temporal precision before
  trusting promotion; tune `PAIR_WINDOW_DAYS` / `PAIR_MIN_ANCHORS` from what it shows.
- Confirm whether stored `SourceTweet` carries expanded/display URLs (entities); if not, URL anchors
  are skipped and cashtag/hashtag/mention anchors carry the matching.
