# Typefully follow-up: test seams, the article quota gap, and request timeouts — Design

**Date:** 2026-07-29
**Branch:** `fix/typefully-followup-seams-and-gaps` (off `fix/typefully-quota-and-resilience`, PR #86)
**Status:** approved for planning

## Motivation

PR #86 made X delivery respect the account's monthly Typefully publishing quota. Its whole-branch
review approved the work and named three gaps it deliberately did not close. This branch closes
them, plus one more found while exploring.

### The article path is ungated, and invisible to the gate

`src/cli/send-x-article.ts` builds `SendXArticle` with no quota reader, and `SendXArticle.run`
creates one Typefully draft per approved article item, unbounded. Worse than the bypass: those
drafts land in `JsonXArticleLedger`, not the delivery ledger, and `SendChannels` computes its
in-flight count only from the delivery ledger. So a just-scheduled article is invisible to the gate
on all three terms — it is not in `used`, not deducted from `remaining`, and not counted in
`inFlight`.

Run `pnpm send:x-article`, then `pnpm send:channels --target x` inside the two-minute scheduling
window, and the gate approves a batch that together overshoots the ceiling. The overshoot then fails
*at publish time*, which strands rows in `예약됨` — exactly the failure #86 set out to remove.

### `sendToOutlet` has no test seam

`src/cli/serve.ts:290` is a 72-line function closing over module-level singletons, in a file that
calls `startServer()` at import time. It cannot be imported without starting a server, so none of it
is tested.

It is also the highest-consequence untested code on the branch. It removes a ledger row before a
resend and must restore it on **every** path that does not send — currently three of them
(`serve.ts:335`, `:354`, `:359`). #86's review found a genuine Critical there: the quota-refusal
branch had been added between the `remove` and the restores, and skipped the restore. That was
caught by a human reading the control flow, because nothing else could catch it. The next one will
not be.

### A hung socket wedges the reconcile scheduler

`typefullyFetch` sets no request timeout (matching `HttpClient`, which sets none either). The
scheduler's `running` flag is cleared in a `.finally()`, so a pass whose fetch never settles never
clears it, and automatic reconcile stops silently for the life of the dashboard process. A hung send
has the same shape: the operator's click never returns.

### `JsonXArticleLedger` has the write race `JsonDeliveryLedger` just had fixed

`src/adapters/store/JsonXArticleLedger.ts:25-29` — `add()` is an unsynchronized read-modify-write,
the same defect PR #86 fixed in `JsonDeliveryLedger`. The exposure today is small: inside the `serve`
process only the reconcile timer writes it, because the dashboard cannot send articles. But this
branch adds writers, and leaving one of two sibling ledgers fixed invites the next reader to assume
the other was considered and rejected.

## Design

### 1. `makeSendToOutlet` — `src/cli/sendToOutlet.ts`

A factory, the same shape `typefullyQuotaReader.ts`, `reconcileScheduler.ts` and `loadQuota.ts`
already use on this branch. `serve.ts` keeps one call.

**Inject only what is module state or reads the environment.** `outletById`,
`deliveredByChannelSender`, `deliveryKey`, `outletsForChannel` and `SendChannels` are pure imports
and stay imports — injecting them would push the parameter list past a dozen and force every test to
restate the real outlet definitions, which is the opposite of a seam.

Injected: the four stores (`formattingStore`, `deliveryLedger`, `translationStore`, `overrideStore`)
plus the env/IO functions (`chatIds`, `xMaxWeighted`, `senders`, `headroom`, `recorder`, `archiver`),
each defaulting to the real implementation.

**Tests.** The resend restore invariant, on all four paths — restored on a quota refusal, restored
on `sent === 0`, restored on a throw, and **not** restored on success (a fourth `add` would write the
row twice). Plus the guard clauses that return before any send: unknown outlet, not bot-delivered,
missing chat id, and resend with nothing previously sent.

### 2. Serialized writes, shared — `src/shared/store/`

Extract the promise chain PR #86 put in `JsonDeliveryLedger` into a small helper and use it in both
ledgers. Copying it a second time is what a reviewer would flag, and fixing one of two siblings is
what the next reader would misread as a decision.

The helper is pure — no file IO — so it is tested directly: FIFO order, a rejected predecessor does
not block its successor, and a rejection still reaches its own caller rather than being swallowed.

### 3. One place computes headroom — `src/cli/publishHeadroom.ts`

Today two places compute "how much can still go out", and this branch would make it three:

| surface | counts |
| --- | --- |
| `SendChannels` gate | `remaining − awaitingPublish(delivery ledger)` |
| board banner (`makeLoadQuota`) | the same arithmetic, separately implemented |
| `SendXArticle` | nothing |

The obvious fix — hand `SendChannels` the article ledger — needs a 13th constructor parameter, and
#86's spec set twelve as the ceiling. Take the better road instead: **stop having the gate do the
arithmetic at all.**

```ts
export interface Headroom {
  /** The account's raw remaining publishes, for display. */
  remaining: number;
  /** Publishes already spent this month — the banner's denominator is `used + remaining`. */
  used: number;
  /** Scheduled but not yet confirmed published, across BOTH ledgers. */
  inFlight: number;
  /** `remaining − inFlight` — the number the gate enforces. May be negative; clamp only for display. */
  available: number;
  resetsAt: string;
}
```

`used` is carried because the board banner renders `잔여 N건 (예약 M건 대기) / {used + remaining}건`
and would otherwise lose its denominator.

**This module replaces the two that exist**, rather than sitting beside them:

- `src/cli/loadQuota.ts` (`makeLoadQuota`, `QuotaView`) becomes `publishHeadroom.ts`. The board's
  `loadQuota` dependency keeps its name and its always-200 `{ …, error? }` contract — only the
  payload widens to `Headroom` — so `apiHandlers.ts`, `web/src/api.ts` and the `web/src/types.ts`
  mirror change shape but not structure.
- `src/cli/typefullyQuotaReader.ts` (`quotaReader`) is absorbed too: its job was to return
  `undefined` when X is not a target or Typefully is unconfigured, and that guard moves onto the new
  reader unchanged. A Telegram-only install must still get `undefined` and never construct a
  Typefully client.

One module computes headroom: the Typefully read stays behind the existing 60-second TTL, both
in-flight counts are recomputed on every call (local file reads, and a stale count would put the
surfaces back into disagreement).

Consequences:

- `SendChannels`' 12th parameter changes **type** from `() => Promise<PublishingQuota>` to
  `() => Promise<Headroom>`. The parameter count is unchanged, and the method gets *smaller* — the
  `inFlight` filter leaves it.
- `SendXArticle` takes the same reader as a new optional last parameter and refuses
  **all-or-nothing for the whole run** — if the number of articles this run would send exceeds
  `available`, none of them go, exactly as `SendChannels` refuses the whole X portion. Reported as
  `quotaBlocked` on the result, leaving `failed` at 0: an account at its ceiling is a refusal, not a
  failure. `pnpm send:x-article` prints the same style of warning `send:channels` does.
  Like `SendChannels`, the count is taken **before** any draft is created, and a throwing reader logs
  and proceeds rather than blocking delivery.
- The banner reads the same value it always did, now provably the same one both gates enforce.

`ReconcilePublished.ts:68` decides an article is still pending with an inline
`isXUrl(row.url) || !row.postId`. Extract it as `awaitingArticlePublish`, for the reason
`awaitingPublish` exists: the reconcile pass and the headroom count must not hold two definitions of
"in flight".

**Cost:** one extra ledger read per batch — `SendChannels` currently reuses an array it has already
loaded. Cheap for a single source of truth.

### 4. Per-attempt request timeouts

`TypefullyCallOptions` gains `timeoutMs`, implemented with `AbortSignal.timeout()`, applied **per
attempt** rather than as a whole-call budget — standard, and it does not entangle with the retry
loop.

- **20s** for API calls → 60s worst case across three attempts.
- **120s** for the media download and the S3 `PUT` → 6 minutes worst case, acceptable because
  neither retries on anything but a genuine 5xx, and a blanket short timeout would break large
  uploads.

A timed-out `POST /drafts` deserves a note. The abort surfaces as a fetch rejection, so the existing
non-idempotent branch already turns it into *"the request may still have been processed; check the
Typefully queue before re-running"*. A timeout is the **canonical** case for that message — the
server may well have created the draft and only the response was lost. No new handling is needed;
the design's requirement is a test that pins the existing behaviour so a future refactor cannot
quietly start retrying it.

## Testing

- **`makeSendToOutlet`**: the four restore paths (refusal, zero-send, throw, and no double-write on
  success) plus the four early-return guards.
- **Serialized-write helper**: FIFO order; a rejected job does not block its successor; a rejection
  propagates to its own caller.
- **`JsonXArticleLedger`**: two concurrent `add()` calls both survive — and the test must fail
  against the unserialized version, verified before it is kept.
- **`publishHeadroom`**: `available = remaining − inFlight` across both ledgers; the Typefully read
  is cached inside the TTL and refetched after it; an error is not cached; in-flight is recomputed
  per call; `used` survives to the caller for the banner's denominator; the reader is `undefined`
  when X is not a target or Typefully is unconfigured (the guard inherited from `quotaReader`).
  The existing `loadQuota` tests move here and must keep passing against the widened payload.
- **`awaitingArticlePublish`**: an unreconciled article row is in flight; one carrying an `x.com`
  url is not; one with no `postId` is not.
- **`SendXArticle` gate**: over headroom → nothing sent, reported as a refusal not a failure; within
  headroom → normal; a throwing reader does not block the send (matching `SendChannels`).
- **`typefullyFetch` timeouts**: an idempotent call that times out is retried; a non-idempotent one
  is not and carries the "may still have been processed" message; the media paths get the longer
  budget.

## Out of scope

- Converting `SendChannels`' constructor to an options object. This design removes the pressure that
  would have forced it; doing it anyway is unrelated churn.
- A component-test harness for `web/` (no jsdom/testing-library in the repo today). The banner
  wiring stays verified by Playwright.
- Timeouts in `HttpClient`, which has the same gap for Lark and twitterapi. Same fix, different
  blast radius, and nothing on this branch depends on it.
- **Cross-process ledger race.** Both ledgers now serialize *within* a process, but a CLI
  `send:channels` run while `serve` is up gives two serializers over one file, and
  `writeJsonFileAtomic` does not make a read-modify-write atomic. `serialWrites.ts:11-12` says so
  honestly. Not introduced here.
- **`inFlight` has no escape hatch.** A row that can never be reconciled — a draft deleted in
  Typefully's UI, or one that failed at publish time — counts against `available` forever, across
  monthly resets, and the only remedy is hand-editing JSON. Against a 15/month ceiling one stuck row
  costs 1/15 of capacity indefinitely. The direction is conservative (blocks rather than
  over-publishes), which is why it is not urgent.

Two accepted behaviours the final review surfaced, recorded here rather than fixed: resending a row
whose original draft is still queued consumes two publishes while the gate counted one (the original
is deliberately not cancelled), and `TypefullyMedia`'s 120s budget covers `arrayBuffer()`, so a
large-but-progressing download can now abort — safe direction, it throws before any draft exists.
