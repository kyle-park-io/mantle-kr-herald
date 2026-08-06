# X publish reconcile — the account is the record, not the board

The board reports what this pipeline produced. @0xMantleKR reports what was actually published. Those
are two different sets today, and the second one is the truth. This makes the system read the account
on a timer and update its own records from what it finds, whichever route a post took to get there.

Written 2026-08-06. Every number below was measured against production and the live account that day,
not inferred.

## The question this started from

> 내가 파이프라인을 통해서 올릴 수도 있고, 부분적으로 진행하고 핸즈온으로 올릴 수도 있고 하잖아.
> 결과는 x에 게시된 걸 보면 알 수 있는 거니까 정기적으로 데이터를 업데이트해주는 게 필요한 거 아니냐는 소리야.

Right, and the pipeline's records are structurally incapable of answering it on their own. There are
at least three routes to a published post — the full pipeline, a partial run finished by hand, and
copy that never entered the system — and only the first one leaves a trace. The account is the one
place all three converge.

## What the gap actually is

Measured 2026-08-06 against production and @0xMantleKR:

| | Count |
| --- | --- |
| Live posts on @0xMantleKR since 2026-07-20 | **47** (28 of them since 07-30) |
| `x`-channel renderings in the database, all time | **3** |
| …of those, already carrying an `x-post` ledger row | 2 — both **@bcd_kyle test sends** |
| Translations in production | 8 (3 approved) |
| Entries in the local `output/translations/translations.json` | 5 |

**None of the three renderings appears among the 47 live posts.** Scored with the existing
`similarity` (`src/domain/kol/attribution.ts`), the best match for each was 0.350, 0.127 and 0.148 —
and a copy-paste scores near 1.0, because that function strips URLs and emoji and normalises
whitespace before taking Jaccard over character 3-grams. The local file tree holds fewer items than
production, so the work was not done locally either.

So the board is not out of sync with reality. The board is accurately reporting that this pipeline has
produced three X renderings ever, while the account published 47 times. The pipeline is stalled at the
1차 검수 gate — five translations are waiting on a human, and nothing becomes a rendering until one is
approved — and in the meantime the account's output is being written outside the system.

That is the state a reconcile has to be designed for: **most live posts will have no item, and that is
normal, not an error.**

## The measurement that shapes the matching

`MATCH_THRESHOLD = 0.3` in `src/domain/kol/attribution.ts` carries a comment saying it is an initial
value with no data to calibrate against. This is the first real measurement, and it is a negative one:
**an unrelated live post scored 0.350 against one of our renderings** — above that threshold. Recording
a delivery on that evidence would have written a `sent` row for a post that is not ours, and `sent` is
never reversed (`src/domain/delivery/models.ts:5`), so a legitimate send would have been blocked
permanently with no way back.

The lesson is not "raise the constant". It is that **the KOL matcher and this reconcile are different
jobs sharing one function.** The KOL matcher asks *"which of our campaigns is this KOL echoing?"* — a
topical question, deliberately loose, and its own doc says it is "a *suggestion*, never authoritative"
with a human confirming every row. This reconcile asks *"is this literally the copy we approved?"* —
an identity question. Copy-paste is not a similarity problem.

`MATCH_THRESHOLD` is therefore left alone, and this feature carries its own, far stricter constant.

## Design

### Three verdicts per live post

For each live thread, compared against every `status: "approved"`, `channel: "x"` rendering:

| Verdict | Condition | Effect |
| --- | --- | --- |
| **Confirmed** | near-identical to an approved rendering | write a delivery row for that item on `x-post`, with the post id and url. The board shows 발송됨 whether a bot or a human put it there |
| **Candidate** | scores in the middle band | **reported, never written.** A human decides. `sent` is irreversible, so an unattended guess is the one mistake with no undo |
| **External** | no rendering comes close | record it as publish history under `kr:<rootId>` — the account's real output, which is also what `impressions:record` needs |

The bands: **confirmed at ≥ 0.95**, **candidate from 0.50 to 0.95**, external below. 0.95 is chosen
against the only real data point there is — the 0.350 false positive — leaving a wide margin, and
identical text scores 1.0 by construction. There is no measured *true* positive yet, because no
approved rendering has ever been posted to this account; the band is therefore uncalibrated in the
positive direction, and that is deliberately the safe direction to be wrong in: a threshold set too
high demotes a real match to a reported candidate, which costs a human one confirmation. Too low
writes an irreversible row. Revisit once the first genuine pipeline post gives a true positive to
measure, and record the number in this file when it does.

### `sent`, not `delivered`, and no new status

`src/domain/delivery/models.ts:5-6` already draws the distinction this feature needs:

> `sent` is an observation — a bot or API call succeeded — and is never reversed.
> `delivered` is a claim: a human ticked 전달함 after pasting it by hand, and can untick it.

A post read back off X is an **observation** — it has a post id and a url. So a confirmed match writes
`sent`, and `ALL_DELIVERY_STATUSES` needs no widening.

No existing use case writes such a row, though: `SendChannels` writes `sent` as a side effect of
actually sending, and there is no path that records a send someone else performed. So this feature owns
a small new recorder — it takes an item, the `x-post` outlet, a post id, a url and the observed
timestamp, refuses to overwrite an existing row for that key, and writes nothing else. Keeping it
separate from `SendChannels` matters: that class sends, and a recorder that cannot send is the whole
point.

This also explains why `MarkDelivery`'s refusal (`src/app/MarkDelivery.ts`) stays exactly as it is.
That guard rejects `delivered: true` on an `auto` outlet like `x-post` because a human's unverifiable
*claim* on an auto room would make `send:channels` skip it silently. A verified observation is not that
claim. The reconcile closes the gap the guard correctly refused to open by hand — and a human still
cannot tick 전달함 on `x-post`, which remains right.

### One row per thread, keyed on the root

`assembleThreads` (`src/domain/threadAssembler.ts`, the same function `collect` uses) collapses a root
and its replies into one logical post. Matching compares the assembled thread text; recording uses the
root's id and `createdAt`. This matches what a person means by "a post", and X's own thread impressions
concentrate on the root. Per-reply performance is not recorded; if that is ever wanted it is a
different feature, not a wider row.

### `kr:` for posts with no item

External posts need an `itemId` because `RecordPublish` upserts on `(itemId, type, channel, outletId)`
— a blank id would collapse every external post into one row. They get `kr:<rootId>`: the existing
convention is that the prefix names provenance (`x:` is an @Mantle_Official source post), and `kr:`
says "published by the Korean account, no upstream item". A distinct prefix also keeps these ids out of
`x:`-parsing code paths — `src/adapters/content/xArticleMeta.ts` short-circuits on anything that does
not start with `x:`, so a `kr:` id can never trigger a lookup that silently finds nothing.

### Where the two kinds of record go

- **Confirmed** → the delivery ledger, in Postgres, per database. This is what the board reads and
  what `send:channels` gates on.
- **External** → the `history` tab of the team's Google Sheet, via `RecordPublish`. That tab is
  columns A–J with `RecordImpressions` owning H/I, and it fetches by `postId` for every row whose
  channel is `x` (`src/app/RecordImpressions.ts:4,38-42`) — so backfilling it is what finally gives
  §9b X rows to measure, a gap recorded as open for weeks.

The asymmetry is not a compromise; the two answer different questions. "Did this item go out?" is
per-database state. "What has the account published?" is one shared team record with no local variant.

### The CLI and its timer

`pnpm x:reconcile [--since <ISO|30d>] [--handle <h>] [--yes]`

- Handle defaults to `REFERENCE_X_HANDLE`, falling back to `0xMantleKR` — the convention
  `collect-reference.ts:13`, `tm-measure.ts:14` and `metrics-record.ts:16` already share.
- **Preview unless `--yes`.** It writes to a shared team workbook and to an irreversible ledger;
  `db:import`'s preview-only-without-`--yes` is the established precedent in this repo.
- `skipIfLocal`, like both of its siblings (`history:record`, `impressions:record`) — the sheet half
  is meaningless in local mode.
- Reads via `fetchAuthoredTweets`, which pages newest-first under `DEFAULT_MAX_PAGES`. It never touches
  the collect watermark and never writes `x_threads`: that corpus is @Mantle_Official's English source
  content, and this account is neither.

**Its own systemd timer**, `herald-x-reconcile.{service,timer}`, not a stage inside `pnpm watch`. The
watch tick is the translate pipeline and spends agent turns; this is a read-and-record pass with
unrelated failure modes, and folding it in would let a translation failure stop reconciliation. The
deploy pattern, including the timer/timeout coupling test added in PR #122
(`tests/deploy/watchTiming.test.ts`), is reused rather than reinvented.

### Idempotency

Re-running must be a no-op. `RecordPublish` upserts on `(itemId, type, channel, outletId)` and
`kr:<rootId>` is unique per thread, so external rows converge. Confirmed rows are checked against the
ledger before writing, and an existing row for `(itemId, type, x-post)` means the work is done —
including the two @bcd_kyle test rows, which the reconcile must therefore leave alone rather than
"correcting" to a @0xMantleKR post id. Those two rows record a real send to a real account; they are
history, not an error.

## Out of scope, deliberately

- **Telegram and KakaoTalk.** Neither can be read back the way X can — there is no API returning "what
  is in this room" for a bot that did not post it, and the KakaoTalk rooms are `delivery: "manual"`
  already. A reconcile there would be a different mechanism, not a wider loop.
- **A dashboard surface for candidates.** They are reported by the CLI and land in the journal. If the
  middle band turns out to be busy in practice, that is when a confirmation UI earns its place.
- **`MATCH_THRESHOLD` is not retuned.** It belongs to the KOL matcher and its calibration is a separate
  question, still waiting on a real August sweep.
- **Importing external posts as pipeline *items*.** An external post gets publish history, not a
  translation row. Making the board list content the pipeline never produced is a much larger change to
  what the board means.
- **The 1차 검수 backlog.** Five translations wait on a human, and no automation may approve them —
  the agent translates and renders, a person approves. This feature makes the gap visible; it does not
  close it, and it must not be mistaken for closing it: reconciling what was hand-posted records
  reality, it does not move the pipeline forward.

## Testing

| Test | Asserts |
| --- | --- |
| the verdict function | ≥0.95 → confirmed; 0.50–0.95 → candidate; below → external. The measured 0.350 pair lands in **external** — the correct outcome, since that post is not ours and must not cost a human a confirmation either |
| thread assembly | a root with six replies produces one verdict and one row, keyed on the root |
| idempotency | a second run over the same live posts writes nothing, including against the two pre-existing @bcd_kyle `x-post` rows |
| `kr:` ids | never match `x:`-prefixed code paths; two different threads never share an id |
| preview | without `--yes`, no sheet write and no ledger write happens |
| the real shapes | the delivery row a confirmed match produces is `status: "sent"` carrying the post id and url |
| deploy | the new timer's `TimeoutStartSec` is bounded against its `OnCalendar` period, same check as `herald-watch` |
