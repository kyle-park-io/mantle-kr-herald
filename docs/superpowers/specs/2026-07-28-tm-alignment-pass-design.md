# TM alignment pass — align a draft against nearest-precedent EN↔KO pairs — design

Date: 2026-07-28
Status: approved for planning
Scope: the deferred next slice of translation memory (PR #52). A new **optional** step,
`translate:align`, that revises a drafted-but-unapproved translation against the nearest
@0xMantleKR precedent pairs, between `translate:save` and 1차 검수. Anchor-based selection only;
agent-assisted (local Claude, **no Claude API**), human still gates at 1차.

## Context

PR #52 built the translation-memory engine: @0xMantleKR posts Korean translations of
Mantle_Official's English posts, so the two accounts form approved EN↔KO pairs (`translation/tm.json`,
promoted via `tm:promote`). `PrepareTranslations` already inlines the pairs most relevant to a batch
into the **translation prompt** (`selectRelevantTm`, `MAX_TM_FEW_SHOTS=6`) — so a fresh draft is
already influenced by relevant precedent.

But that influence is **diluted**: the pairs sit in one large shared prompt beside the glossary, the
200-line style guide, and up to eight other few-shots, and the agent translates every item in the
batch from that one context. A precedent that matters for one specific item competes with everything
else. The **alignment pass** is a second, *focused* pass on the finished draft: put a single draft
next to only the precedents nearest to **it**, and ask the agent to conform the draft's phrasing and
terminology to how those same anchors were translated before. Tighter feedback loop, higher signal —
the classic translation-memory "fuzzy match then adopt", applied after drafting rather than before.

It reuses PR #52's pairing/anchor engine wholesale; the only new machinery is per-draft selection
(instead of per-batch) and a worksheet that pairs a draft with its precedents.

**Where it sits (optional, like `format --refine`):**

```
translate:prepare → agent translates → translate:save (status: translated)
                                              │
                                        ▼ translate:align            ← new, optional
                              alignment worksheet (draft + precedents)
                                        → agent revises → translate:save (still: translated)
                                              │
                                        ▼ 1차 검수 (dashboard, human) → approved
```

Skipping `translate:align` leaves the pipeline exactly as it is today.

## Decisions

### 1. `translate:align` — a worksheet over drafted-but-unapproved translations

`pnpm translate:align [--ids <id,…>] [--since <YYYY-MM-DD>] [--limit <n>]`. Reads every `Translation`
with `status === "translated"` (a draft that has not passed 1차; an `approved` translation is done and
is never touched), applies the same selector shape as `translate:prepare`, and writes an **alignment
worksheet** to `paths.translationsWorksheets` (`align-<stamp>.md`). The local agent revises each
draft in the worksheet; the operator writes each revised Korean back with the **existing**
`translate:save --id <id> --file <korean.txt>` — no `--approve`, so the item stays `translated` and
still faces 1차 검수. `translate:save` already falls back to an already-saved translation when an id
is not in the current `pending.json` batch, so it re-saves the revised text with the original
`sourceText` unchanged — **no new save command, no `pending.json` for align.**

### 2. Anchor-based, per-draft precedent selection (reuse the #52 engine); K = 3; skip on none

For each draft, select the top **K = 3** precedent pairs by shared-anchor overlap between the draft's
**English `sourceText`** and each TM pair's `source`, reusing `extractAnchors`/`sharedAnchors` from
`src/domain/tm/anchors.ts`. This is exactly `selectRelevantTm`'s ranking narrowed from a batch to one
text; expose it as `selectPrecedents(sourceText, tm, k)` in `src/domain/tm/selection.ts` (equal
scores keep input order, matching `selectRelevantTm`). A draft with **zero** shared-anchor precedents
is **excluded** from the worksheet — alignment only helps where a precedent exists — and counted as
skipped. K = 3 (not the batch prompt's 6): a single draft next to three near precedents is focused,
not a wall of examples. Anchor overlap only; lexical/text similarity for anchorless drafts is a
non-goal (below).

### 3. Slim worksheet context — draft + its precedents, nothing else

The alignment worksheet is **not** a re-translation. It carries a short instruction and one block per
aligned draft:

- **원문** — the English `sourceText`.
- **현재 번역** — the current Korean draft (`koreanText`).
- **선례** — the K precedent pairs (each pair's EN `source` + KO `target`).
- Instruction: *revise the draft to match the precedents' phrasing and terminology where they apply;
  keep everything else; preserve `---` thread separators, cashtags/hashtags/mentions, and links.*

The glossary and the 200-line style guide are **deliberately omitted**: the draft already passed
through them at `translate:prepare`, and the precedent pairs themselves encode the team's usage.
Keeping the context to draft + precedents is what makes this a tight alignment pass rather than a
second full translation, and keeps the worksheet small.

### 4. `PrepareAlignment` use-case — mirrors `PrepareTranslations`, simpler

`PrepareAlignment` (`src/app/PrepareAlignment.ts`) loads `translated` drafts from the
`TranslationStore`, applies the selector, loads `tm.json` via a `FewShotStore`, selects each draft's
precedents, and assembles the worksheet from the drafts that have ≥1 precedent. Returns
`{ worksheet: string; aligned: number; skipped: number }`. No source gateway, no network, no new
port — it reads two local stores and emits a string. The CLI prints
`aligned N · skipped M (no precedent)` and the worksheet path.

## Architecture

- **Domain:**
  - `src/domain/tm/selection.ts` — add `selectPrecedents(sourceText: string, tm: FewShotExample[],
    k: number): FewShotExample[]` (per-draft anchor ranking; reuses `extractAnchors`/`sharedAnchors`).
  - `src/domain/translation/alignmentWorksheet.ts` — `assembleAlignmentWorksheet(blocks:
    AlignmentBlock[]): string` and the `AlignmentBlock` shape `{ itemId, sourceText, draftKorean,
    precedents: FewShotExample[] }`, producing the markdown described in Decision 3.
- **App:** `src/app/PrepareAlignment.ts` — `PrepareAlignment` with `run(selector)` →
  `{ worksheet, aligned, skipped }`.
- **CLI:** `src/cli/translate-align.ts` (mirrors `translate-prepare.ts`: parse `--ids/--since/--limit`,
  wire `JsonTranslationStore` + `JsonFewShotStore(paths.translationConfigDir, "tm.json")`, write the
  worksheet, print counts). `package.json`: `"translate:align": "tsx --env-file-if-exists=.env
  src/cli/translate-align.ts"`.
- **Reuse (unchanged):** `translate:save` / `SaveTranslation` for writeback; `TranslationStore`;
  `JsonFewShotStore`; `extractAnchors`/`sharedAnchors`; `argValue`; the `Selector` shape;
  `registerErrorHandler`; `paths.translationsWorksheets`.

### Data flow

```
translate:align [--ids|--since|--limit]
  TranslationStore.loadAll() → keep status === "translated"      (drafts, pre-1차)
  apply selector (ids / since ≥ cutoff on translatedAt / limit)
  tmStore.load() → FewShotExample[]  (translation/tm.json)
  per draft:
     selectPrecedents(draft.sourceText, tm, 3)
       ≥1 → AlignmentBlock{ itemId, sourceText, draftKorean: koreanText, precedents }
        0 → skip (skipped += 1)
  assembleAlignmentWorksheet(blocks) → align-<stamp>.md
  print "aligned N · skipped M (no precedent)"
     → local agent revises each 번역
     → translate:save --id <id> --file <revised.txt>   (status stays "translated")
     → 1차 검수 (dashboard) approves the aligned draft
```

## Error handling

- No `translated` drafts (after the selector) → write nothing, print `nothing to align`.
- `tm.json` empty / every draft anchorless → `aligned 0 · skipped N (no precedent)` with a hint to run
  `tm:promote` first. Not an error — alignment is optional and simply has nothing to do.
- Re-runnable and idempotent-by-nature: the worksheet is regenerated from the current drafts each run,
  so re-aligning an already-revised draft just converges. No ledger.
- `translate:save` writeback is unchanged, including its saved-translation fallback and its
  few-shot-promotion gate (irrelevant here — align never approves).

## Testing

- `PrepareAlignment` (fake `TranslationStore` + fake `FewShotStore`): selects only `translated`
  drafts and never an `approved` one; picks each draft's precedents by anchor overlap on its
  `sourceText`; a draft with no shared-anchor precedent is skipped and counted, not emitted; the
  worksheet contains the draft's Korean and its precedent pairs; `--ids`/`--since`/`--limit` filter as
  in `PrepareTranslations`; `aligned`/`skipped` counts are exact.
- `selectPrecedents`: returns the top-K by shared-anchor count, `> 0` only, equal scores keep input
  order, `k` caps the result — pinned to concrete anchors/values so each assertion can fail.
- `assembleAlignmentWorksheet`: a block renders 원문 / 현재 번역 / 선례 with the exact pair text; an
  empty block list is handled.
- No live calls — the pass is pure local file work; all tests use synthetic drafts and TM pairs.

## Non-goals

- **Lexical/text-similarity precedent matching** for anchorless drafts — anchors only this slice;
  a token/n-gram fallback is the next enhancement (deferred, per the brainstorm).
- **A dashboard alignment view** — CLI + worksheet only; the human sees the *result* at 1차 검수,
  which already exists.
- **Auto-approval** — align never approves; 1차 검수 stays the human gate.
- **Claude API** — the "agent" is local Claude filling a worksheet, exactly like `translate:prepare`.
- **Touching `PrepareTranslations`' prompt path** — the batch-prompt TM inlining (`selectRelevantTm`)
  is unchanged; alignment is additive.
- **A new store, port, or `pending.json` for align** — writeback reuses `translate:save`.

## Global constraints

- Runtime deps stay **zod-only**; this feature adds no dependency and makes no network call.
- Reuse the #52 anchor engine (`extractAnchors`/`sharedAnchors`) — do not reimplement anchor logic.
- The human gate is **1차 검수**; a saved alignment stays `status: "translated"`.
- Selector semantics match `PrepareTranslations` (`--ids` exact, `--since` on the stored timestamp,
  `--limit` default 20).
- Public repo: no steering content, no real post text, no PII in code or tests — synthetic only.

## Open items to verify (not blockers to planning)

- On real data, confirm how many of the pending drafts actually have shared-anchor precedents in the
  current `tm.json` (only 1 verified pair exists today) — if most drafts skip, that is the signal that
  the lexical fallback (non-goal above) is worth the next slice, and/or that a fuller `tm:pair`
  backfill should come first.
- Confirm the assembled alignment worksheet reads clearly enough that the agent revises rather than
  re-translates — tune the instruction wording on the first real run.
