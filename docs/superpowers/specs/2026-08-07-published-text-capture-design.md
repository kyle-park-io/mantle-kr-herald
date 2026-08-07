# Capture the published text — the edit is the signal

Reconcile already knows which live post each of our translations became, and scores how close the two
are. It then throws the live text away. This makes the system keep it, so the difference between what
we wrote and what actually went out becomes readable — starting with the glossary and locale rules
that difference silently contradicts.

Written 2026-08-07. Every number below was measured against production and @0xMantleKR that day.

## The question this started from

> 가장 최근에 구매하신 토큰화 자산은 무엇입니까? 이거 보면 결국 최종 적으로 올라간건 가장 최근에 구매한
> 토큰화 자산은 무엇인가요? 이거 잖아. 최종으로 올라간 값이 따로 저장이되어야. glossary 등 더 정렬이
> 될거같은데

The example is real and it is worse than a wording preference. Production row
`x:2082149990282207365` (`status: posted`, `postedUrl` →
[2083065235720765791](https://x.com/0xMantleKR/status/2083065235720765791)) holds our draft:

> 가장 최근에 **구매하신** 토큰화 자산은 무엇**입니까**?

What the account actually published was:

> 가장 최근에 **구매한** 토큰화 자산은 무엇**인가요**?

`translation/locale.json` says:

```json
"honorific": "합니다체(존댓말) 기본. '~해요'체와 혼용하지 않습니다."
```

Our draft followed that rule exactly. The published version is 해요체 — the form the rule forbids. So
either the rule is wrong about how this account really speaks, or a human made a one-off call. **There
is no way to tell today**, because the published text is stored nowhere. That is the gap: not "we
should archive posts", but "the one recurring judgement that corrects our steering config is
discarded every six hours."

## What is already there, and what is dropped

`x:reconcile` runs every six hours and matches each translation against the live timeline. On
2026-08-07 it retired 14 translations at scores 0.644–0.986 — each one a confirmed
`our draft ↔ their published post` pair, with the amount of human editing quantified by the score.

`ReconcileXPublished.ts:590` keeps this:

```ts
plan.posted.push({ itemId, rootId, score, url, postedAt });   // no text
```

`match.thread` holds the live body at that moment. `publish_entries` has a `content_hash` column but
no body column. So the pairing — the expensive, ground-truth part — is computed and discarded.

### Why this is better data than `tm:pair` already produces

`tm:pair` proposes EN↔KO pairs heuristically: a 14-day window and at least 2 shared anchors across two
separately collected corpora, reviewed by a human before `tm:promote`. It is guessing which Korean
post corresponds to which English one.

Reconcile is not guessing. It knows the link, because it matched *our own translation* to the live
post, and the score tells you how much the human changed. 0.986 means published essentially as
written; 0.644 means a third of it was rewritten. That delta is the highest-value signal in the
system and nothing reads it.

## Scope

In:

1. Store the published text on the translation row.
2. Backfill rows that are already settled, when the post is still in the fetched window.
3. Glossary compliance against the published text.
4. A report of terms the humans overrode — our draft used the decided rendering, the published post
   did not.

Out, deliberately:

- **TM / few-shot promotion from published text.** Not deferred out of caution — it is not designable
  yet. A promotion threshold has to be calibrated against labelled `(draft, published)` pairs, and
  there are zero stored pairs today. Storing is the prerequisite for labelling. Setting a promotion
  threshold by guess is exactly the mistake `2026-08-07-hand-posted-reconciliation-design.md` §"The
  measurement" was written to avoid, and an unlabelled set measures the labelling, not the metric.
- **The reverse direction** (published uses a decided term our draft missed). The existing
  `translate:check` already catches a draft that missed a term; reporting it twice adds noise.
- **The `confirmed` route.** A confirmed match scores ≥ `CONFIRMED_AT` (0.95) against an approved
  rendering — published and draft are near-identical by construction, so there is no edit to learn
  from. Phase A's settled rows are still backfilled (they are hand-posted twins), which is different.

## The finding that shaped the design

The obvious implementation — have `RetireTranslation` write the text alongside `postedUrl`/`postedAt`
— **would have backfilled nothing.** `xReconcile.ts:427`:

```ts
if (ctx.historyPostIds.has(rootId)) return { kind: "claim", rootId, retire: false };
```

A settled translation whose post already carries a history row returns `retire: false` and never
re-enters `plan.posted`. All 14 rows retired on 2026-08-07 have their history rows, so none of them
would ever have been seen by a writer hanging off the retire path. The bug would have been silent: a
feature that appears to work, on a table that stays empty.

So capture is **decoupled from retiring entirely**. This also keeps
`settledTranslationDisposition`'s invariants (claimed / released / settled rootIds, and the
post-condition that a released post is never also retired) completely untouched — that logic is
delicate and has nothing to do with archiving a body of text.

## Design

### 1. Schema

`translations.published_text text`, added through the existing generated-alter mechanism in
`schema.ts` — the same path `posted_url` and `posted_at` took:

```ts
{ table: "translations", column: "published_text", type: "text" },
```

Domain: `Translation` gains `publishedText?: string`.

**`pnpm db:migrate` is required before the next tick.** No CLI applies the schema on its own, and a
column added to an existing table breaks the live scheduler until migrated.

### 2. The capture rule

One sentence, and it is the whole feature:

> For every translation whose post id is known and whose `published_text` is empty, write the live
> body of that post as it appears in this run's fetched thread pool.

Consequences, each deliberate:

- **"post id is known"** covers both cases with one rule — a row already carrying `postedUrl` (the id
  parsed out of it with the same url parser `settledTranslationDisposition` already uses, so a
  `postedUrl` pointing at another account or a malformed one is skipped rather than guessed at), and
  a row this run just retired via `plan.posted` (which carries `rootId` directly). No second code
  path for backfill.
- **"is empty"** means fill-only. Never overwrite. The pass is idempotent and safe to re-run, and a
  human correction to a stored value is never clobbered by a later run.
- **"in this run's fetched pool"** means a post aged out of the `--since` window is skipped, not
  fetched specially. The cell stays empty and a later run with a wider `--since` fills it. No extra
  twitterapi.io calls: this reads threads reconcile already fetched.
- Stored **exactly as read from X** — no `stripMedia`, no marker normalisation, no trimming.
  Normalisation can be applied on read; information dropped at write cannot be recovered. Same
  reasoning that keeps `lineage` unrewritten.

Retire and history logic are unchanged, to the line.

### 3. Glossary and locale reads

Two commands' worth of behaviour, both read-only:

- `pnpm translate:check --published` runs the existing `checkGlossary` against `publishedText`
  instead of `koreanText`, skipping rows that have none. This answers "does what we actually publish
  follow the glossary?" — which nobody has ever been able to ask.
- A new report: for each glossary entry whose term occurs as prose in the source, where the decided
  rendering **is** in our draft but **is not** in the published text, report the override. This is
  the signal that a glossary entry is wrong rather than a translation being wrong. Implemented as a
  new function in `glossaryCompliance.ts`, next to `checkGlossary`, sharing `occursAsProse`.

Both report, never gate — the standing convention here (`checkGlossary`'s own doc comment): a run
that refuses on a finding gets switched off, and a check that is off catches nothing.

The locale/honorific case from the opening question is not a glossary term and is not detected by
either report. It becomes *visible* the moment the pair is stored — a human reading a draft and its
published twin side by side sees it immediately. Automating it needs its own measurement and is not
in this spec.

### 4. Error handling

A capture failure is counted and printed, never thrown, and never fails the run's retire or history
work — the same shape `historyFailed` already has in `x-reconcile.ts`. Retry is automatic and needs
no bookkeeping: the cell is still empty, so the next run tries again.

### 5. Testing

Unit, TDD, RED first:

- fills an empty cell from the pool
- never overwrites a cell that already has a value
- skips a row whose post is not in the pool
- leaves `status`, `postedUrl`, `postedAt` and the history row untouched
- fills a freshly retired row and an already-settled row through the same rule
- the override report finds a term present in the draft and absent from the published text
- the override report ignores a term that never occurs as prose in the source

One reconcile-level test asserts the 2026-08-07 shape directly: a settled translation whose post
carries a history row — the `retire: false` case above — still gets its text captured. That is the
regression guard for the finding that shaped this design.

## What this unlocks later

Once pairs accumulate, the labelling that the TM work needs becomes possible: read N stored
`(draft, published)` pairs, label each "same message / materially rewritten", and calibrate a
promotion threshold against that labelled set. The score distribution over time also becomes a real
quality metric — how much the humans edit, trending — which today does not exist in any form.

Neither is in this spec. Both are unreachable without it.
