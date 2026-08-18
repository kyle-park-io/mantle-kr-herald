# The 1차 검수 edit is a signal too — design

Date: 2026-08-18
Status: approved for planning
Scope: record **who** changed a translation on every `lineage` write, so the difference between the
last machine draft and the Korean a human approved at 1차 검수 becomes readable — and feed that
difference into `glossary:mine` beside the published-text signal it already mines.

Every number below was measured against production on 2026-08-18.

## The question this started from

> 우리가 지금 스케쥴러 중에 실제로 x에 올라간거로 어디가 바꼈는지 확인하는거 있잖아. 이것 너무
> 좋은데, 만약 내가 1차 검수에서 사람손으로 수정한 경우는? 그렇게 하면 이것도 정렬이 들어간 것이니
> 수집이되어야하는데, 그거 하고 있어?

It is not being done. The answer is worth writing down precisely, because the reason is not "nobody
built the miner" — it is that **the data cannot currently tell a human edit from a machine one.**

## What exists today

`2026-08-07-published-text-capture-design.md` built one edit signal: `x:reconcile` matches a
translation against the live @0xMantleKR timeline, stores what actually went out in
`translations.published_text`, and `glossary:mine` mines the word-level substitutions between the
two (`substitutionEdits`, `src/domain/translation/glossaryMining.ts:323`). Its gate is one line:

```ts
if (!t.publishedText || !t.koreanText) continue;   // glossaryMining.ts:326
```

34 production rows carry a `published_text`. That is the entire input.

A 1차 검수 edit never reaches it. Two things do happen to it, and neither is this:

- **The result is kept.** `SaveTranslation.ts:79` promotes the approved Korean into the
  `translation` few-shot scope (25 rows in production), so the *finished text* steers the next
  batch's prompt.
- **The versions are kept.** `SaveTranslation.ts:69` appends to `lineage` on every save. Production
  holds 198 `translated` entries across 45 items; on 10 of those items the content changed at least
  once, and on 35 the stored text never moved after the first draft.

What is discarded is the **difference** — which words a reviewer replaced, and with what. That is
exactly the quantity the published-text path mines, and on this side it is arguably the better
signal: a reviewer's edit is a deliberate correction by someone who read our style guide, where a
hand-posted rewrite is an unattributed judgement by whoever happened to publish.

## Why the miner cannot simply be pointed at `lineage`

Because a second machine writes into the same shape. `translate:align` — the alignment pass from
`2026-07-28-tm-alignment-pass-design.md` — is not a manual command: `herald-watch` runs it every two
hours (`docs/ko/schedulers.md:20`, `translate:prepare → 에이전트 → translate:align → 에이전트`), and its
revision is saved by the same `pnpm translate:save`, through the same `SaveTranslation`, producing a
`lineage` row identical in every field to the one a dashboard edit produces.

The `lineage` table is `(item_id, stage, variant, content, status, source_text, at)`. **No actor.**
So of the 10 items whose text moved:

| | items |
| --- | --- |
| Certainly human — the content changed on the entry that also carried `approved` | **2** |
| Indistinguishable — content changed while still `translated` (align, or a reviewer who saved before approving) | **8** |

Eight of ten are unattributable, and the 8 are not a rounding error to be waved through: a reviewer
who edits and clicks 저장 before 승인 ✓ — the flow `docs/ko/review.md` §3 actually instructs — lands
in exactly that bucket. Mining the ambiguous rows would feed agent-authored phrasing into a
corpus whose whole purpose is to record what *humans* decided, and the errors would be invisible
because both sides look the same on disk.

## Decisions

### 1. `lineage` gains an `actor`, written at every append

A new nullable `text` column via the existing generated idiom
(`addColumn("lineage", "actor", "text")`, `src/adapters/db/schema.ts:45`), surfaced as
`LineageEvent.actor` so `listEvents` can project it without pulling `content` across the wire.

Nullable, not `not null default`: a null means "written before this existed", which is the truth for
all 198 rows and is not the same claim as "an agent wrote it".

### 2. The taxonomy is `"human" | "agent"`, decided at the construction site

Not a flag on `translate:save`, and not inferred from timing. The two producers are already two
different processes, and the split falls out of where the use case is built:

| construction site | actor | what it is |
| --- | --- | --- |
| `src/app/createDeps.ts:282` | `"human"` | the dashboard — a 1차 검수 edit, and the 되돌리기 path |
| `src/cli/translate-save.ts:40` | `"agent"` | `pnpm translate:save`, from both the drafting and the alignment pass |

A flag would have made correctness depend on the local agent remembering to pass it, on every save,
forever; the construction site cannot forget. `SaveTranslation` takes the actor as a constructor
argument beside `lineage` — one value per process, not one per call, because no process is
sometimes a human.

**`agent:translate` vs `agent:align` is deliberately not modelled.** It is derivable when it is ever
wanted (the first agent entry for an item is the draft, later ones are alignment revisions), and the
question this design answers only needs the human/agent line. The same reasoning applies to the four
other `LineageStore` producers (`SaveConversion`, `SaveRendering`, `SaveOutletOverride`,
`ApproveRendering`); they take the same argument so no stage is left writing a null forever, but
nothing in this design reads them.

### 3. The baseline is the last agent entry before the first human one

The "before" side of the diff is **not** the original machine draft. It is the text as it stood when
the reviewer opened it — after `translate:align` has had its pass — because the question is what the
human changed, not what the whole pipeline changed. Concretely, per item: the last `actor:"agent"`
`translated` entry that precedes the first `actor:"human"` one, paired against the item's
`korean_text` at `approved`.

Items with no human entry produce no pair, and that is correct rather than a gap — "the reviewer
changed nothing" is a fact about the draft, not an edit to mine.

It is worth being exact about how small the pool is, because it sets expectations for the first
runs. Of the 35 items whose text never moved, **25 were retired to `posted` by `x:reconcile`** and 3
are still `translated`; the remaining 7 no longer have a translation row at all. **None of the 35 is
`approved`** — most were hand-posted and matched, so no reviewer ever opened them. The signal this
unlocks is therefore worth 2 certain pairs today, plus whichever of the 8 ambiguous ones prove
human. The reason to build it now is not the back catalogue, which is unrecoverable either way
(§6), but that every reviewer edit from here on is otherwise discarded at the same rate.

### 4. `substitutionEdits` is generalised, not copied

The existing function is already the right algorithm — greedy sentence alignment, then word-level
set difference, with pure insertions and deletions dropped for having no "instead of what". Only
its parameter names are specific to the published-text case. It becomes `before`/`after` over a
`TextPair`, and both callers adapt into it:

- published-text: `{ before: koreanText, after: publishedText }`
- human-edit: `{ before: <baseline from §3>, after: koreanText }`

One algorithm, two feeds. Copying it would leave two sentence aligners to keep in agreement, and
`SENTENCE_MATCH_MIN`/`MAX` and `MAX_DIFF_WORDS` are tuned constants that must not drift apart.

### 5. The output is a third signal in `glossary:mine`'s review file

Not a new command. `glossary:mine` already exists to answer "which terms has nobody decided yet",
already runs the corpus cross-validation that makes a candidate list usable rather than noise
(`src/cli/glossary-mine.ts:27`), already writes a human review file and alerts with its absolute
path, and already never exits non-zero on a finding. A separate `edits:mine` would duplicate all of
that to produce a second file nobody has a habit of opening.

The review file distinguishes the two sources per candidate — a term a reviewer changed and a term
whoever published changed are different kinds of evidence, and the human deciding the glossary entry
should see which one they are looking at.

### 6. Non-goals

- **No backfill.** The 198 existing rows cannot have an actor recovered — the information was never
  written — and guessing one from timestamps would manufacture exactly the confidence this design
  exists to establish. They stay null and are skipped by the miner.
- **No change to what steers a prompt.** This produces candidates for a human to accept into
  `translation/glossary.json`. Nothing here writes a glossary entry, a few-shot row, or a style rule.
- **No 2차 edits.** A reviewer's per-channel edit is an edit to *converted copy*, not to a
  translation, and it has no English source to anchor a glossary term against. The actor column will
  record it; nothing in this design mines it.
- **No actor on the dashboard's own display.** `pnpm lineage` gains the actor in its render because
  the column is free there; the review board does not change.

## Data model

```ts
// src/domain/lineage/models.ts
export type LineageActor = "human" | "agent";

export interface LineageEvent {
  itemId: string;
  stage: LineageStage;
  status?: string;
  /** Who wrote this entry. Absent on every row written before 2026-08-18 — see §6. */
  actor?: LineageActor;
  at: string;
}
```

`PgLineageStore` adds `actor` to its insert, its full select, and — because it is cheap and
`listEvents` exists to answer questions like this one — its projected select.
`JsonlLineageStore` carries it as another JSON field; old lines simply lack it.

## Migration and the surrounding machinery

- **Schema.** One generated `alter table lineage add column if not exists actor text`, idempotent
  like every other statement, applied by `pnpm db:migrate` — which `deploy/herald-deploy.sh` already
  runs on every deploy.
- **`db:export` / `db:import`.** Lineage rows round-trip through both; the field rides along with no
  change to either file's shape beyond the new key.
- **`state:push` / `state:pull`.** Untouched — lineage is not one of the seven irreproducible files
  those two carry (`docs/ko/capabilities.md` §M).
- **Order of deployment.** The column must exist before code that writes it runs, which the deploy
  script's ordering already guarantees (steering → deps → `db:migrate`) only because the timers do
  not fire mid-script. Nothing here is safe to hand-deploy out of order.

## Testing

- `SaveTranslation` writes the actor it was constructed with, and both call sites construct it with
  the right one — the second half tested at the call sites, since a use-case test cannot see which
  process built it.
- The baseline picker: an item with agent-only entries yields nothing; an item with agent → human
  yields that pair; an item with agent → human → agent (a re-run after an edit) still pairs against
  the last agent entry *before* the human one.
- `substitutionEdits` keeps every existing published-text case passing under the renamed parameters
  — those tests are the proof the generalisation changed no behaviour.
- A null-actor row is skipped, not guessed.

## Risk

The one that matters: **an actor is a claim about provenance, and a wrong one is worse than none.**
If a third call site appears and is constructed with `"agent"` because that is what the neighbouring
line said, human edits start flowing into the corpus mislabelled and nothing will show it. The
mitigation is that the argument is required rather than defaulted, so a new call site cannot inherit
a wrong answer silently — it has to state one.
