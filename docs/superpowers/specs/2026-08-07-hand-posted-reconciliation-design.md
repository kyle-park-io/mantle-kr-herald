# Hand-posted reconciliation — the machine ranks, the human confirms

Issue #125 says `x:reconcile` cannot see the most common hand-post shape: a translation pasted before
it ever became a rendering. That is true, and the fix is not the one the issue proposed. Measured
against production and the live account on 2026-08-07, a hand-post is not a paste at all — it is a
**rewrite** — and no cheap text metric can tell a rewrite of our copy apart from an unrelated post on
the same topic. So this feature stops trying to decide, and instead puts the evidence in front of the
person who already knows.

Every number below was measured, not inferred. The measurement is what changed the design.

## What was actually measured

Three items sat in 1차 검수 after a tick, and issue #125 recorded that two of them had already been
published by hand on 2026-07-31. Scoring every live @0xMantleKR thread in a 14-day window against
every translation in production, with the same `similarity()` the reconcile already uses:

| our translation | live root | score |
| --- | --- | --- |
| `x:2082149990282207365` | `2083065235720765791` (07-31 05:40) | **0.423** |
| `x:2082108368806941060` | `2083065040081719763` (07-31 05:39) | **0.365** |
| `x:2080608995371597892` | `2081657420854763782` (07-27 08:26) | **0.379** |

The third row is new information: `x:2080608995371597892` is an **approved** translation, already
published to Drive, and it too went out by hand under different wording. The hand-post shape is
broader than issue #125 recorded — it is not confined to unapproved items.

Why the scores are so low is visible in the text:

```
ours : 가장 최근에 구매하신 토큰화 자산은 무엇입니까?
live : 가장 최근에 구매한   토큰화 자산은 무엇인가요?
```

```
ours : 토큰화 주식은 발행부터 거래까지, 모든 과정이 맨틀 안에서 이루어집니다.
live : 토큰화 주식의 발행부터 거래까지, 전  과정이 맨틀 안에서 이루어집니다.
```

These are unmistakably the same post to a human. Korean is agglutinative: swapping an ending
(`무엇입니까` → `무엇인가요`), a particle (`은` → `의`), or one word (`모든` → `전`) rewrites a large
fraction of the character 3-grams the metric counts. A hand-post is a rewrite, and `CONFIRMED_AT`
(0.95) was calibrated for a copy-paste that does not happen.

## Why lowering the threshold does not work either

Treating those three pairs as the positive set and every other (translation, live thread) pair as
negative:

| metric | min positive | max negative | margin |
| --- | --- | --- | --- |
| current — 3-gram Jaccard | 0.365 | 0.308 | 0.057 |
| 2-gram Jaccard | 0.453 | 0.390 | 0.063 |
| 2-gram Dice | 0.624 | 0.561 | 0.063 |
| LCS ratio | 0.672 | 0.628 | 0.044 |
| 3-gram containment | 0.539 | 1.000 | overlaps |
| 2-gram containment | 0.624 | 1.000 | overlaps |

Every metric that separates at all separates by about 0.05, on a positive set of three. And the
negatives run that high for a structural reason that will not go away: the negatives are *our own
other translations* against *live posts on the same RWA subject matter*, so genuine near-misses are
the normal case for this account, not the exception.

A 0.05 margin measured on three examples is not a foundation for an automatic decision whose failure
mode is silently retiring a legitimate item out of a human's review queue.

## The property that does hold

For all three positives, the true match was the **top-scoring** live thread for that translation.
The metric ranks perfectly and classifies not at all. That asymmetry is the whole design:

> **`similarity` is used as a ranker, never as a judge.**

The threshold stops being "is this the same post?" and becomes only "is this worth showing to a
person?" — a question where being wrong costs one glance.

## Design

### A suggestion, not a verdict

`x:reconcile` gains a fourth output alongside `confirmed` / `candidates` / `external`:
**`suggestions`**. A suggestion asserts nothing. It writes no delivery row, no history row, and does
not change the translation.

This is a **second pass, and it iterates translations rather than threads.** The existing pass walks
live threads and asks "whose copy is this?"; the suggestion pass walks translations and asks "did
this one go out?" — which is the question the board is stuck on, and it is the direction that makes
"one suggestion per translation" a property of the loop rather than a rule bolted onto it. It runs
over the same `threads` the first pass already assembled, and skips:

- any translation whose `posted_url` is already set (see 되돌리기, below);
- any translation whose itemId the rendering route confirmed in this same run — that item already
  has a delivery row, which is the stronger record;
- any thread already consumed by a confirmed rendering match, so one live post cannot both be a
  delivery row and a suggestion.

For each surviving translation it takes its single best-scoring live thread and, if the score clears
a review floor, records a suggestion row.

`REVIEW_FLOOR = 0.30`, set just below the lowest measured true positive (0.365) — deliberately low,
because the cost of a wrong suggestion is a person reading two short texts and clicking 아님, while
the cost of a missed one is the item staying stuck forever, which is the bug being fixed. It sits
*below* the highest measured negative (0.308) on purpose: this floor is not trying to exclude
negatives, and a negative that happens to be its translation's top-1 will surface. That is the
accepted cost of never missing a real one. This constant lives beside `CONFIRMED_AT`/`CANDIDATE_AT`
in `src/domain/publish/xReconcile.ts` and carries a comment saying it is a display floor, not a
decision boundary.

Top-1 per translation only. The measurement says top-1 was right in every case; storing a ranked
list of alternates is work with no evidence behind it. A human who disagrees with the top-1 clicks
아님 and the item returns to the ordinary queue.

### The rendering route is untouched

The existing rendering path — approved `x` renderings, `CONFIRMED_AT`, an `x-post` delivery row via
`RecordObservedDelivery` — keeps its current behaviour exactly. It compares against copy that passed
2차 검수 and carries a real `type`, and a copy-paste of a rendering genuinely does score near 1.0.
The suggestion route runs only for translations, and only for a thread the rendering route did not
already confirm. Nothing about `isXCandidateRendering`, `CONFIRMED_AT`, or the delivery write changes.

### Storage: one new table

```
x_post_suggestions
  item_id     text primary key   -- the translation this is a suggestion for
  root_id     text not null      -- the live thread's root tweet id
  score       double precision not null
  live_text   text not null      -- snapshot, so the dashboard need not call twitterapi.io
  url         text not null
  posted_at   text not null      -- the live post's createdAt
  seen_at     text not null      -- when the reconcile recorded this
  rejected_at text               -- set when a human clicks 아님
```

`live_text` is stored rather than re-fetched because the dashboard runs hosted on Vercel with no
twitterapi.io credential and no budget for a per-page-view API call; the whole point of the panel is
to show both texts side by side.

A suggestion is replaced on each run (upsert by `item_id`) **unless** it has been rejected — a
rejected suggestion stays rejected, and the reconcile skips that item, or the next tick would put
the same thing back in front of the human who just dismissed it.

### Retiring a translation

`TranslationStatus` gains a third member, **`posted`** (board label **`게시됨`**).

Not `published`: in this repo `publish` already means "uploaded to Drive" (`drive:publish`,
`publish_entries`, `PublishTranslations`), and a second meaning on the same word would be read wrong
by everyone including us. `posted` matches `PublishRecord.status: "posted"`, which already means
"live on the account".

`TranslationStatus` is currently a hand-written union. It becomes **derived from
`ALL_TRANSLATION_STATUSES`**, the convention `ALL_DELIVERY_STATUSES`, `ALL_TYPES` and `ALL_CHANNELS`
already follow, and for the reason recorded in `src/domain/delivery/models.ts`: esbuild strips
`satisfies` without evaluating it, so a separately-declared union plus a checked literal both erase
at runtime and a test walking the list keeps walking the old members forever.

Two columns are added to `translations`, via `alter table … add column if not exists` — the shape
`auth_attempts.last_attempt_at` already uses in `src/adapters/db/schema.ts`:

```
posted_url  text
posted_at   text
```

`posted_url` is both the evidence and the "already resolved" marker, and that dual role is what makes
되돌리기 stick:

- **Retire** sets `status = 'posted'`, `posted_url`, `posted_at`.
- **`x:reconcile` skips any translation whose `posted_url` is set**, whatever its status.
- **되돌리기** sets `status` back to `translated` and **keeps `posted_url`**, so the next tick does not
  immediately re-suggest what a human just undid. The board shows such an item as 대기 with a note
  naming the live post it was once matched to.

Ordering matters: the status write happens first, the history row second. If the history write fails
the item is still retired and the next run retries the row; the reverse order would leave an item
that can never be retired because its own history row makes the reconcile skip it.

### The publish-history row

On retire, a `PublishRecord` is written keyed `x:<itemId>` — not `kr:<rootId>`, because unlike the
`external` route we know the owner — with `type: "x"`, `channel: "x"`, `outletId: "x-post"`,
`postId: <rootId>`, `status: "posted"`, `publishedAt` from the live post. This is what gives
`impressions:record` (which filters `channel === "x" && postId`) something to measure.

It carries its own idempotency, independent of the retire: skipped when `x:<itemId>` is already in
`historyIds` or the rootId is already in `historyPostIds`, the checks that exist today.

There is no `deliveryKey` here and therefore no `type` collision — issue #125's question 2 does not
arise, because nothing on this path writes a delivery row.

### Where the human acts

In the 1차 검수 detail pane, an item carrying an unrejected suggestion shows a panel:

- the two texts side by side — ours and the live post — with the score and a link to the live post
- **`게시됨으로 종결`** → retire (status, `posted_url`, `posted_at`) + the history row
- **`아님`** → set `rejected_at`; the panel disappears and the item stays an ordinary 검수 대기 row

A `posted` item is **locked, not hidden**: the text is shown read-only, editing and 승인 are disabled,
the live post is linked, and a **`되돌리기`** button is offered. `StatusChip` gains a third branch in a
neutral colour — it is neither the amber of 대기 nor the mint of 승인 — and `TranslationList`'s filter
gains 게시됨.

### Automation boundary

`x:reconcile --yes` writes suggestion rows automatically; that is safe precisely because a suggestion
decides nothing. It never retires a translation. The timer therefore keeps its unattended schedule
with no new risk, and the only thing that changes a translation's status is a human clicking.

## What this cannot do, stated rather than implied

Copy written entirely outside the system will never be matchable — there is nothing to match it
against. It lands in `external` publish history keyed `kr:<rootId>`, and that is the complete extent
of what any amount of matching can offer it. Issue #125's question 4 is answered "yes, that is all,
by definition."

## Out of scope, deliberately

- **Telegram.** `telegramMatchCandidates` has the same blind spot; this spec covers X only.
- **Lark-sourced translations.** X only, matching the reconcile's existing scope.
- **Re-converting a `posted` item.** A retired item is terminal for this pipeline; if the team wants
  to run it through conversion later, 되돌리기 first.
- **Ranked alternates.** Top-1 only, per the measurement above.
- **Changing `CONFIRMED_AT` or the rendering route.** Untouched.
- **Retro-fixing history rows already written as `kr:<rootId>`.** The `x:reconcile` timer was stopped
  before its first unattended run on 2026-08-07 precisely so this case would not be created; an
  install that already has such rows deletes them by hand before the item-linked row can be written.

## Testing

- **The three real pairs become fixtures.** Their measured scores (0.365 / 0.379 / 0.423) and the
  highest measured negative (0.308) are pinned, asserting the two properties the design rests on:
  the true match is top-1 for each, and no threshold separates positives from negatives by more than
  ~0.06. If a future change to `similarity` breaks either property, this test says so.
- `REVIEW_FLOOR` is pinned against those numbers: a test that would still pass if the floor were
  moved to 0.9 is a test that cannot fail, so it asserts all three positives are surfaced *and* that
  a pair measured below the floor is not. It must **not** assert that every negative is excluded —
  the floor sits below the highest measured negative by design, and a test written to that stronger
  claim would be pinning behaviour the design explicitly rejects.
- The rendering route's precedence: a thread the rendering route confirmed produces a delivery row
  and **no** suggestion, and its translation is skipped by the second pass. Without this the same
  live post could be recorded twice by two different mechanisms.
- Suggestion idempotency: a second run replaces an unrejected suggestion, and leaves a rejected one
  alone.
- The `posted_url` skip: an item with `posted_url` set gets no suggestion, whatever its status —
  including after 되돌리기, which is the behaviour that makes the undo stick.
- Write ordering: a failing history write leaves the translation retired and the next run retrying;
  the item is never left unretireable.
- Frontend: the panel renders for an unrejected suggestion and not for a rejected one; a `posted`
  item disables edit/승인 and offers 되돌리기; `StatusChip` and the list filter cover three statuses.
- `ALL_TRANSLATION_STATUSES` is walked by the existing `tests/web/typeMirror.test.ts` shape, so a
  member added in the domain and missed in the web types fails a test rather than shipping.
