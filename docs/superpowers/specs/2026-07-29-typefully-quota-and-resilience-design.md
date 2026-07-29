# Typefully publishing quota, retries and automatic reconcile — Design

**Date:** 2026-07-29
**Branch:** `fix/typefully-quota-and-resilience` (off `main`)
**Status:** approved for planning

## Motivation

A live audit of the Typefully integration this session (real calls against the `@bcd_kyle` account,
social set `283589`) turned up one operational surprise and three gaps.

### The surprise: the binding limit is the monthly publishing quota, not the rate limit

Rate limits are per-resource, user-scoped, one-hour windows, and they are generous — nowhere near
our volume:

| endpoint | limit/hr | observed remaining |
| --- | --- | --- |
| `GET /v2/me` | 5000 | 4999 |
| `GET /v2/social-sets/{id}/drafts` | 2500 | 2499 |
| `GET /v2/social-sets/{id}/` | 500 | 499 |

`X-RateLimit-SocialSet-*` headers did not appear on any read; per Typefully's docs they attach to
writes such as `drafts.create`. We have not observed one, so the retry wrapper below logs those
headers when a 429 does occur, which is how we will learn their real shape.

The real constraint is the **social set's monthly publishing quota**:

```json
"publishing_quota": { "used": 9, "remaining": 6, "resets_at": "2026-08-01T00:00:00+09:00" }
```

Fifteen published posts per month, resetting on the 1st (KST). Nine were already spent at audit
time. Nothing in the codebase reads this field.

This matters because an X send is *scheduled*, not immediate (PR #76 — X blocks direct publishing of
drafts containing URLs). If the quota runs out at publish time rather than at draft-create time, the
ledger already says `sent`, `ReconcilePublished` never finds a url, and the row sits in `예약됨`
forever while the board reports a delivery that never happened. That is precisely the class of lie
PR #85 set out to remove from the board.

### Gap: no retries on any Typefully call

All four Typefully adapters use a single raw `fetch` with no retry:
`TypefullySender.ts:33`, `TypefullyArticleSender.ts:25`, `TypefullyMedia.ts:24`,
`TypefullyDraftLookup.ts:18`. The repo already has `HttpClient` (`src/shared/http/HttpClient.ts:46`)
which retries 429/5xx/network errors three times with exponential backoff, but only Lark and
twitterapi use it. It does not fit the Typefully adapters as-is: `TypefullyMedia` downloads bytes
from an arbitrary host and `PUT`s them to a presigned S3 URL, neither of which `HttpClient`'s
JSON-only interface can express.

### Gap: `parseArticleId` does not match the URL Typefully actually returns

`parseArticleId` looks for `/article/(\d+)` (`src/adapters/send/typefullyPublish.ts:20`, doc comment
says `https://x.com/i/article/<id>`). The live value on draft `10097410` is:

```
x_article_published_url: https://x.com/bcd_kyle/status/2082141042959401225
```

`/status/`, not `/i/article/`. The regex misses, so `ReconcilePublished.ts:77`'s
`postId: u.articleId ?? row.postId` falls back and leaves a **Typefully draft id** in the article
ledger's `postId`. The url is corrected but the id is not, so §9b impressions look up an id X has
never heard of.

(The drafts *list* endpoint omits `x_article_published_url`; only the detail endpoint returns it.
`TypefullyDraftLookup` already uses the detail endpoint, so that part is correct.)

### Gap: reconcile is manual

`ReconcilePublished` runs only from `pnpm send:reconcile` or the board's button
(`src/cli/serve.ts:247`). Since every X send is two minutes in the future, a freshly sent row is
*always* unreconciled, and stays that way until a human clicks.

## Design

### 1. `TypefullyQuota` — new adapter

`src/adapters/send/TypefullyQuota.ts`. Reads `GET /v2/social-sets/{id}/` and returns
`{ used, remaining, resetsAt }`.

**The trailing slash is required.** Without it the API answers `301` with an empty body — confirmed
live. This gets a comment, because the failure is silent and non-obvious.

Constructor takes `(apiKey, socialSetId, fetchFn = fetch)` like its sibling adapters.

### 2. Quota gate in `SendChannels`

Before the send loop, only when the batch has X candidates, fetch the quota **once**:

```
needed    = number of pending X room deliveries in this batch
available = remaining − (ledger rows currently satisfying awaitingPublish)
needed > available  →  block every X room; Telegram proceeds normally
```

Subtracting `awaitingPublish` rows is what makes this correct across back-to-back runs. A draft
created 30 seconds ago has not published yet, so it is not in `used` and not deducted from
`remaining` — without this term, two batches inside the two-minute scheduling window would each see
the same `remaining` and together overshoot the quota. Those rows are already loaded in memory
(`SendChannels.ts:101`), so the term costs no extra API call.

The gate is all-or-nothing for X, per the decision: no partial batch, so there is no "how far did it
get" state for an operator to reconstruct.

**Reported as a refusal, not a failure.** `SendChannels.ts:44` already establishes that an install
behaving as intended must not inflate `failed`; the same reasoning applies here. The result gains:

```ts
quotaBlocked?: { needed: number; available: number; resetsAt: string };
```

`failed` stays 0 and nothing is pushed into `failures[]` — the board renders the refusal from
`quotaBlocked` alone. Putting it in both would double-report one event in two different vocabularies.

If the quota lookup itself throws, the send proceeds — a monitoring call must not become a new way
for delivery to fail. The failure is logged.

### 3. `typefullyFetch` — new retry wrapper

`src/adapters/send/typefullyFetch.ts`. A factory returning a `fetch`-shaped function, so each
adapter wraps its injected `fetchFn` once in its constructor and every existing `if (!res.ok)` block
stays as-is. Three attempts, 1s/2s exponential backoff — same shape as `HttpClient` so the two read
alike.

Retry policy is deliberately asymmetric:

| condition | retry | why |
| --- | --- | --- |
| `429` | yes | rejected before processing — nothing was created |
| `5xx` / network error, `GET` or `PUT` | yes | idempotent (the S3 `PUT` overwrites one presigned object) |
| `5xx` / network error, `POST /drafts` | **no** | the draft may exist even though the response was lost |
| `5xx` / network error, `POST /media/upload` | yes | a duplicate media record is inert — it is never published on its own |
| other `4xx` | no | a human has to fix it |

The no-retry rule is scoped to **draft creation specifically**, not to `POST` as a method. The
wrapper therefore takes an explicit `idempotent: boolean` option per call rather than inferring the
rule from the HTTP verb, so the one dangerous call site names itself and the rest are not silently
governed by it.

The `POST /drafts` row is the important one. A lost response on draft creation is indistinguishable from a
rejected one; retrying it automatically publishes the same post twice and burns two of fifteen
monthly slots. Not retrying does not *eliminate* the duplicate — a later human rerun can still
create a second draft, since no ledger row was written — but it puts a person between the ambiguity
and the second attempt.

So the `POST /drafts` failure message must state the ambiguity, in the same voice
`SendChannels.ts:192` already uses for a post-send ledger-write failure:

> the draft may have been created — check the Typefully queue before re-running

On a `429`, log `X-RateLimit-User-*` and `X-RateLimit-SocialSet-*`. We have never seen the social-set
headers; this is how we find out what they say.

Applied to: `TypefullySender`, `TypefullyArticleSender`, `TypefullyMedia`, `TypefullyDraftLookup`,
`TypefullyQuota`.

### 4. `parseArticleId` accepts both URL shapes

Match `/i/article/<id>` **and** `/status/<id>`. The doc comment is corrected to the observed live
value. `parseTweetId` matches the same `/status/` pattern, but the two are applied to different
fields (`x_published_url` vs `x_article_published_url`), so there is no ambiguity.

### 5. Automatic reconcile in `serve`

Smaller than it first appears. `ReconcilePublished.ts:51` skips a row before the lookup when it is
not `awaitingPublish`, and the article loop skips on `isXUrl(row.url) || !row.postId` — so a pass
with nothing pending already makes **zero** Typefully calls. No "is anything pending" guard is
needed.

What `serve.ts` adds:

- a 2-minute interval calling the existing `reconcilePublished()`
- an in-flight flag; a tick that finds the previous run still going skips
- errors logged, never thrown — an unhandled rejection here would take the dashboard down
- `unref()` on the timer, cleared on shutdown

The board's manual button is unchanged; it remains the way to force a pass.

### 6. Surfacing the quota

**Low-quota threshold.** `remaining <= 3`, one constant shared by doctor and the board so the CLI and
the screen cannot disagree about when to start worrying. Three is roughly a day's worth of sends at
our current cadence — enough warning to act before a batch is refused.

**doctor.** Under `--live`, a `Typefully  live` check: `GET /v2/me` for key validity, then the social
set for the quota. `ok` normally, `warn` at or below the low-quota threshold, `fail` on a bad key.
Offline, an `optionalCheck` for `TYPEFULLY_API_KEY` / `TYPEFULLY_SOCIAL_SET_ID` — X sending is
opt-in, so absence is a warn, matching how Lark Drive and the Google Sheet are treated
(`src/cli/doctor.ts:53`, `:56`).

**Board banner.** A dedicated `GET /api/typefully/quota` endpoint rather than a new field on
`BoardView`. Board loads are frequent and the social-set bucket is the smallest one we measured
(500/hr), so serve caches the answer for 60 seconds and the banner refreshes on mount and after a
send. Keeping it off `BoardView` also leaves the board's shape untouched.

The banner reads as a count and a reset date — e.g. `X 발행 잔여 6건 · 8/1 리셋` — and takes a warning
colour at or below the low-quota threshold. If the lookup fails the banner is omitted rather than
rendered as a zero: an unknown quota must never be drawn as an exhausted one.

## Testing

- **`typefullyFetch`**: 429 → 200; 5xx exhausting all three attempts; network throw → 200; 400 not
  retried; **a non-idempotent call's 5xx is not retried** while an idempotent one's is; a 429 is
  retried even when non-idempotent. Fake `sleep` asserts the backoff sequence.
- **Call-site wiring**: draft creation is the only Typefully call marked non-idempotent — asserted
  against the senders so a future call site cannot inherit the rule by accident.
- **`TypefullyQuota`**: parses the live payload shape; a non-ok response surfaces as a throw.
- **`SendChannels` quota gate**: `needed > available` → zero X sends, `quotaBlocked` populated,
  `failed === 0`, Telegram unaffected; `needed <= available` → normal send; `awaitingPublish` rows
  correctly reduce `available`; a throwing quota lookup does not block the send.
- **`parseArticleId`**: both URL shapes, plus `undefined`.
- **reconcile scheduler**: fake timers — a tick runs a pass; a tick during an in-flight pass is
  skipped; a throwing pass does not propagate.
- **Quota endpoint**: serves the cached value inside the TTL and refetches after it; a failed lookup
  yields no banner rather than a zero.

## Out of scope

- Upgrading the Typefully plan. This design makes the ceiling visible and enforced; whether to raise
  it is a separate call.
- Verifying a failed `POST /drafts` against the drafts list to recover the created draft. Considered
  and declined — it needs content matching, and the human-in-the-loop message covers the case.
- Migrating the Typefully adapters onto `HttpClient`. The wrapper gives them the same resilience
  without forcing the binary S3 `PUT` through a JSON-shaped interface.
