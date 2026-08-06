# Hand-posted reconciliation — a hand-post is a rewrite, and top-1 separates it cleanly

Issue #125 says `x:reconcile` cannot see the most common hand-post shape: a translation published
before it ever became a rendering. That is right. What the issue got wrong — and what this spec's
first draft also got wrong — is *why* the existing matcher misses it.

Measured against production and the live @0xMantleKR account on 2026-08-07: a hand-post is not a
paste, it is a **rewrite**. `CONFIRMED_AT = 0.95` is calibrated for a copy-paste that does not
happen on this account. But once every pair is labelled by reading it, the same `similarity()`
separates a rewrite of our copy from an unrelated post by a margin of **0.216** — because each
translation is scored against its own best live thread, not against all of them.

Every number below was measured. One of them corrects a number in this document's own first draft.

## The measurement

Nine translations in production, scored against all 21 live @0xMantleKR threads in a 14-day window
with the existing `similarity()`. Each translation keeps only its **top-1** live thread. Every one
of the nine pairs was then labelled by reading both texts:

| our translation | live root | top-1 score | same post? |
| --- | --- | --- | --- |
| `x:2082508440635875381` | `2083067950962209105` | **0.484** | yes |
| `x:2082149990282207365` | `2083065235720765791` | **0.423** | yes |
| `x:2080608995371597892` | `2081657420854763782` | **0.379** | yes |
| `x:2082108368806941060` | `2083065040081719763` | **0.365** | yes |
| `x:2082435849036423597` | `2083067103222128830` | **0.308** | yes |
| `x:2081711456320655644` | `2080549358140105194` | 0.092 | no |
| `x:2080661810034917770` | `2085173023385223575` | 0.085 | no |
| `x:2082610791002579012` | `2083242101031223662` | 0.067 | no |
| `x:2082058492366758108` | `2084845730595033297` | 0.012 | no |

**Lowest positive 0.308, highest negative 0.092, margin 0.216.** Any threshold between roughly 0.10
and 0.30 separates this set perfectly.

Two things this table records that nothing else does:

**Five of nine translations in production were already published by hand.** Issue #125 knew of two.
One more (`x:2080608995371597892`) is an *approved* translation already uploaded to Drive, and two
more (`x:2082435849036423597`, `x:2082508440635875381`) were found only by this measurement. The
hand-post route is not an exception on this account — right now it is the majority path.

**The first draft of this spec reported a margin of 0.057 and concluded that no metric could
separate these at all.** That number was wrong: only three pairs had been labelled by reading, and
every other pair was *assumed* negative. Two of those assumed negatives — 0.308 and 0.484 — are real
matches. The "highest negative" in that draft was a true positive. The lesson is worth keeping: a
separation measured against an unlabelled negative set measures the labelling, not the metric.

## Why the scores sit where they do

```
ours : 가장 최근에 구매하신 토큰화 자산은 무엇입니까?
live : 가장 최근에 구매한   토큰화 자산은 무엇인가요?
```

```
ours : 토큰화 주식은 발행부터 거래까지, 모든 과정이 맨틀 안에서 이루어집니다.
live : 토큰화 주식의 발행부터 거래까지, 전  과정이 맨틀 안에서 이루어집니다.
```

Unmistakably the same post; 0.423 and 0.365. Korean is agglutinative, so swapping an ending
(`무엇입니까` → `무엇인가요`), a particle (`은` → `의`) or one word (`모든` → `전`) rewrites a large
fraction of the character 3-grams the metric counts. An absolute score near 1.0 is unreachable for a
hand-post. The *relative* score against the right thread is still an order of magnitude above every
wrong one.

## Two other signals, tested and rejected

**Media identity.** If both posts carry the same image, that is near-proof. Measured: of the five
positives, **only one** has media on both sides. The other four have no media on either side. And
even that one does not match by URL — the KR account re-uploaded the image, producing a different
media key (`HOUihv6bgAA52e_.jpg` → `HOiIkkQbEAAVD6T.jpg`), so identity would require downloading both
images and comparing perceptual hashes. That means a JPEG/PNG decoder in a repo whose runtime
dependency list is `zod` alone, to strengthen a signal that already separates by 0.216, on one case
in five. Rejected on cost, not on principle: if the text margin ever collapses, this is the first
thing to reach for.

**Anchor overlap.** `src/domain/tm/{anchors,pairing}.ts` already pairs EN↔KO posts for exactly this
account pair, by cashtags/hashtags/mentions that survive translation. Measured: **two of the five
positives have zero anchors in the EN source**, and no positive shares more than one anchor, so
`PAIR_MIN_ANCHORS = 2` rejects all five. Anchors also fail to discriminate where they do exist —
`@nansen_ai` is shared by the true match *and* by an unrelated live thread. Not usable here.

## Design

### A second pass, over translations

`reconcileXPublished` gains a second pass after the existing thread walk. The existing pass walks
live threads asking "whose copy is this?"; this one walks **translations** asking "did this one go
out?" — the question the board is actually stuck on, and the direction that makes "one match per
translation" a property of the loop rather than a rule bolted onto it.

It reuses the `threads` the first pass already assembled and skips:

- any translation whose `posted_url` is already set (see 되돌리기 below);
- any translation whose itemId the rendering route confirmed in this same run — that item already
  has a delivery row, which is the stronger record;
- any thread already consumed by a confirmed rendering match, so one live post can never become both
  a delivery row and a translation match.

For each surviving translation it takes its single best-scoring live thread and, at or above the
threshold, produces a match.

Top-1 only. In all five positives the true match was the top-scoring thread, and the runner-up was
far below it (0.484 vs 0.082; 0.423 vs 0.017; 0.365 vs 0.051). Ranked alternates are work with no
evidence behind them.

### `TRANSLATION_MATCH_AT = 0.25`

Lives beside `CONFIRMED_AT`/`CANDIDATE_AT` in `src/domain/publish/xReconcile.ts`.

Placed deliberately off-centre — 0.058 below the lowest positive, 0.158 above the highest negative —
because the two failure modes are not symmetric. A missed match leaves the item exactly where it is
today, in 검수 대기, costing nothing new. A false match silently retires an item a human still
needed to see. So the threshold sits near the positives, buying margin against the expensive error.

A match below the threshold is printed by the CLI and written nowhere. No suggestion table, no
dashboard panel: with the measured separation nothing currently lands in that band, and building a
review surface for an empty band is speculative work.

### The rendering route is untouched

Approved `x` renderings, `CONFIRMED_AT`, and the `x-post` delivery row via `RecordObservedDelivery`
keep their current behaviour exactly. That path compares against copy that passed 2차 검수 and
carries a real `type`, and a genuine paste of a rendering does score near 1.0. Nothing about
`isXCandidateRendering`, `CONFIRMED_AT`, or the delivery write changes.

### Retiring a translation

`TranslationStatus` gains a third member, **`posted`** (board label **`게시됨`**).

Not `published`: in this repo `publish` already means "uploaded to Drive" (`drive:publish`,
`publish_entries`, `PublishTranslations`), and a second meaning on that word would be misread by
everyone including us. `posted` matches `PublishRecord.status: "posted"`, which already means "live
on the account".

`TranslationStatus` is currently a hand-written union. It becomes **derived from
`ALL_TRANSLATION_STATUSES`**, the convention `ALL_DELIVERY_STATUSES`, `ALL_TYPES` and `ALL_CHANNELS`
already follow, for the reason recorded in `src/domain/delivery/models.ts`: esbuild strips
`satisfies` without evaluating it, so a separately-declared union plus a checked literal both erase
at runtime and a test walking the list keeps walking the old members forever.

Two columns are added to `translations` by `alter table … add column if not exists`, the shape
`auth_attempts.last_attempt_at` already uses in `src/adapters/db/schema.ts`:

```
posted_url  text
posted_at   text
```

`posted_url` is both the evidence and the "already resolved" marker, and that dual role is what makes
되돌리기 stick:

- **Retire** sets `status = 'posted'`, `posted_url`, `posted_at`.
- **`x:reconcile` skips any translation whose `posted_url` is set**, whatever its status.
- **되돌리기** sets `status` back to `translated` and **keeps `posted_url`**, so the next tick does
  not immediately undo the undo. The board shows such an item as 대기 with a note naming the live
  post it was once matched to.

A retired item cannot be approved, so it cannot be converted, formatted, or sent. That — not a
delivery row — is what stops already-published copy from going out twice.

### The publish-history row

On retire, a `PublishRecord` is written keyed `x:<itemId>` — not `kr:<rootId>`, because unlike the
`external` route we know the owner — with `type: "x"`, `channel: "x"`, `outletId: "x-post"`,
`postId: <rootId>`, `status: "posted"`, and `publishedAt` from the live post. This is what gives
`impressions:record` (which filters `channel === "x" && postId`) something to measure.

It carries its own idempotency, independent of the retire: skipped when `x:<itemId>` is already in
`historyIds`, or the rootId in `historyPostIds` — the checks that exist today.

Ordering matters. The status write happens **first**, the history row second. If the history write
fails, the item is still retired and the next run retries the row. The reverse order would leave an
item that can never be retired, because its own history row makes the reconcile skip it.

There is no `deliveryKey` on this path and therefore no `type` to choose — issue #125's question 2
does not arise.

### Automation and its alarm

`x:reconcile --yes` retires automatically; that is what the timer is for, and the evidence supports
it. Every retire logs the itemId, the score, and the live URL. A run that retires **three or more**
items sends a Telegram notice through the existing failure-hook path, because a tick that suddenly
retires a batch is either a real backlog being cleared (worth knowing) or a threshold that has
started misfiring (worth knowing sooner).

The first run after this ships will retire five items and therefore alert. That is correct.

### Where the human acts

A `posted` item is **locked, not hidden**: text shown read-only, editing and 승인 disabled, the live
post linked, and a **`되돌리기`** button offered. `StatusChip` gains a third branch in a neutral
colour — neither the amber of 대기 nor the mint of 승인 — and `TranslationList`'s filter gains 게시됨.

## What this cannot do, stated rather than implied

Copy written entirely outside the system will never be matchable — there is nothing to match it
against. It lands in `external` publish history keyed `kr:<rootId>`, and that is the complete extent
of what any amount of matching can offer it. Issue #125's question 4 is answered "yes, that is all,
by definition."

## Out of scope, deliberately

- **Media / perceptual hashing.** Rejected above on measured cost-benefit; revisit if the text margin
  collapses.
- **Telegram.** `telegramMatchCandidates` has the same blind spot; X only here.
- **Lark-sourced translations.** X only, matching the reconcile's existing scope.
- **Re-converting a `posted` item.** Terminal for this pipeline; 되돌리기 first.
- **Ranked alternates / a suggestion review surface.** Top-1 and a log line, per the measurement.
- **Changing `CONFIRMED_AT` or the rendering route.**
- **Retro-fixing `kr:<rootId>` history rows.** The `x:reconcile` timer was stopped before its first
  unattended run on 2026-08-07 precisely so this case would not be created. An install that already
  has such rows deletes them by hand before the item-linked row can be written.

## Testing

- **The nine labelled pairs become a fixture**, with their measured scores and their labels. Two
  properties are asserted: the true match is top-1 for every positive, and `TRANSLATION_MATCH_AT`
  admits all five positives while rejecting all four negatives. This is the test that would have
  caught the first draft's error, and it fails loudly if `similarity` ever changes underneath.
- The threshold is pinned from both sides. A test asserting only "0.484 passes" would still pass at
  a threshold of 0.4 and is therefore a test that cannot fail; it must assert the 0.308 positive
  passes *and* the 0.092 negative does not.
- The rendering route's precedence: a thread the rendering route confirmed yields a delivery row and
  **no** translation match, and its translation is skipped by the second pass.
- The `posted_url` skip: an item with `posted_url` set is never matched again, whatever its status —
  including after 되돌리기, which is the behaviour that makes the undo stick.
- Write ordering: a failing history write leaves the translation retired and the next run retrying;
  the item is never left unretireable.
- The alert fires at three retires and not at two.
- Frontend: a `posted` item disables edit/승인 and offers 되돌리기; `StatusChip` and the list filter
  cover three statuses.
- `ALL_TRANSLATION_STATUSES` is walked by the existing `tests/web/typeMirror.test.ts` shape, so a
  member added in the domain and missed in the web types fails a test rather than shipping.
