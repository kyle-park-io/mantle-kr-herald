# Typefully hardening: the third answer, resend cancellation, and a cross-process lock — Design

**Date:** 2026-07-29
**Branch:** `fix/typefully-hardening` (off `main`)
**Status:** approved for planning

## Motivation

PR #86 built the publishing-quota gate; PR #89 closed the article bypass. Both named gaps they
deliberately left open, recorded under *Out of scope* in
`docs/superpowers/specs/2026-07-29-typefully-followup-design.md`. This branch closes all three, and
settles one assumption that only a live send can answer.

### The gaps, restated

1. **`inFlight` has no escape hatch.** A row that can never be reconciled counts against `available`
   forever, across monthly resets, and the only remedy is hand-editing JSON. Against a 15/month
   ceiling one stuck row costs 1/15 of capacity indefinitely.
2. **Cross-process ledger race.** Both ledgers serialize writes *within* a process, but a CLI
   `send:channels` run while `serve` is up gives two serializers over one file, and
   `writeJsonFileAtomic` does not make a read-modify-write atomic.
3. **Resend consumes two publishes while the gate counted one** — resending a row whose original
   draft is still queued does not cancel the original.

Gap 3's real cost is not the quota. It is **two live posts**: the original draft publishes on
schedule and the resend publishes alongside it, in a brand room, irreversibly. The double charge is
a side effect.

### The root cause of gap 1

`src/adapters/send/TypefullyDraftLookup.ts:26` is the whole bug:

```ts
if (!res.ok) return {};
```

A 404 (the draft was deleted in Typefully's UI) and a 500 (Typefully had a blip) produce the same
empty result, and `ReconcilePublished` reads that result as "not published yet"
(`src/app/ReconcilePublished.ts:62`). So a draft that will *never* publish is indistinguishable from
one still sitting in the queue, and its row stays `awaitingPublish` forever.

The system is not missing the ability to judge. It is discarding the answer it already receives.

### The unverified assumption

`SendChannels` assumes one Typefully draft costs one publish regardless of how many posts the thread
contains. Nothing in the codebase or Typefully's documented API settles it, and a wrong assumption
here means the gate approves a batch that overshoots the ceiling — the exact failure #86 set out to
remove. It can only be answered by sending and watching the quota move.

## Design

### 1. `published()` returns three answers, not two

Replace the return shape with a discriminated union:

```ts
type DraftState =
  | { state: "published"; xUrl?: string; xId?: string; articleUrl?: string; articleId?: string }
  | { state: "scheduled" }
  | { state: "gone" };
```

- **404 → `gone`.** The draft does not exist; nothing will ever publish from it.
- **Any other non-ok, or a thrown request → `scheduled`.** Conservative on purpose: a Typefully
  outage must never retire a row that is genuinely queued. This preserves today's behaviour for
  every failure except the one we can prove is terminal.
- **200 with a published url → `published`** (unchanged).
- **200 with no published url → `scheduled`** (unchanged), *unless* the body carries an explicit
  failure state — see *Open question* below.

`ReconcilePublished` gains a third branch. On `gone` it retires the row rather than counting it as
`pending`.

### 2. A retired row is `dropped`, not deleted

`DeliveryEntry.status` is `"sent" | "delivered"` today, and the model's own doc comment says
`sent` is an observation that is never reversed
(`src/domain/delivery/models.ts:7-9`). A scheduled-then-deleted draft never reached the room, so
leaving it `sent` is a lie the board repeats; deleting the row makes a `발송됨` disappear during an
automated pass with no explanation.

Add **`"dropped"`** as a third status:

- `awaitingPublish` requires `status === "sent"` (`src/domain/send/awaitingPublish.ts:23`), so a
  dropped row falls out of the in-flight count with no change to the headroom reader.
- The room becomes sendable again, which is correct: nothing went out.
- The board shows it as retired rather than sent, so the state change is legible.

The article ledger's `XArticleSentEntry` has no status field. It gains `droppedAt?: string`, and
`awaitingArticlePublish` excludes rows that carry it. Two shapes, one meaning — the alternative is a
status field on a ledger whose rows have never had one.

**The invariant a third status creates.** Every reader that treats the presence of a ledger row as
"this room already received this copy" must now exclude retired rows, or the room stays permanently
unsendable — the opposite of the intent. `DeliveryLedger.loadKeys()` is the obvious one, since
`SendChannels` skips keys it returns; the board's row state and the first-delivery guard are the
others to check. Planning enumerates them; a test pins each. Re-sending upserts by key, so a
successful resend replaces the dropped row rather than accumulating beside it.

**Costs to pay explicitly:** the `web/` type mirror (locked by the existing `typeMirror` test) and
the board's status rendering.

### 3. Resend looks before it cancels

`src/cli/sendToOutlet.ts:97-101` removes the previous ledger row and proceeds. Before that removal,
if the previous row is `awaitingPublish`, consult the *same* `published()` the reconcile uses:

| answer | action |
| --- | --- |
| `published` | **Refuse the resend.** Write the real `x.com` url into the row first, so the board is immediately correct, and tell the operator the original is already live. |
| `gone` | Nothing to cancel. Proceed. |
| `scheduled` | `DELETE /v2/social-sets/{id}/drafts/{draftId}`. On success, proceed. **On failure, refuse** — a failed cancellation means the original may still publish, and proceeding would double-post. |

Draft deletion is already known to work: PR #76's live exploration created a scheduled draft and
deleted it (204).

Actor and reporter share one predicate, the way `sendBlock` backs both `SendChannels` and
`buildBoard`, and `isStale` backs both `drive:publish` and `pnpm status`. A resend cannot disagree
with the board about whether the original is live.

The `cancel` capability belongs on the same port as the lookup, so `ReconcilePublished` and the
resend path depend on one narrow interface rather than two adapters.

### 4. A cross-process file lock

`createSerializer` has exactly two callers — `JsonDeliveryLedger` and `JsonXArticleLedger`. The
files judged to need in-process serialization are precisely the send ledgers, and they are precisely
where the cross-process gap bites, because a lost row means a live post the ledger cannot see, which
the next run publishes a second time.

New `src/shared/store/fileLock.ts`:

```ts
withFileLock(path: string, fn: () => Promise<T>): Promise<T>
```

- Acquire by creating `<path>.lock` with the `wx` flag — `O_CREAT | O_EXCL` is atomic on every
  platform this runs on, and needs no dependency.
- On `EEXIST`, retry with backoff up to a bounded wait, then fail loudly rather than proceeding
  unprotected.
- Reclaim a lock whose mtime is older than a staleness threshold: a process killed mid-write must
  not wedge the tool permanently.
- Release in `finally`, including on throw.

The existing `serial(...)` calls stay. In-process contention keeps using the queue (cheaper, and it
preserves ordering); the lock wraps the job inside it, so the two mechanisms compose rather than
compete. `pnpm clean`'s stranded-temp sweep (`isStrandedTempFile`) learns to remove abandoned
`.lock` files.

## Live verification

The protocol below runs **after** the code lands, against a **synthetic item** (`x:qa-<stamp>`) with
a short two-post rendering injected into `output/formatted/renderings.json`, sent to the test account
**@bcd_kyle** (social set `283589`). Kyle's real items, approvals and few-shot corpus are not
touched — reverting E2E pollution by keeper id was error-prone last time, and a synthetic item makes
the cleanup a deletion instead of a reconstruction.

Order matters: step 1 establishes the billing unit that every later budget estimate depends on.

| # | What it settles | Method | Publishes |
| --- | --- | --- | --- |
| 1 | **Thread billing unit, and when the charge lands** | Send the two-post thread. Read `pnpm doctor --live` immediately before, immediately after scheduling, and after the post goes live. A delta of 1 means per-draft billing, 2 means per-tweet. The three readings also reveal whether the charge lands at scheduling or at publication — which decides whether the gate's arithmetic is right. | 1–2 |
| 2 | **Gap 1 end to end, and the deleted-draft response** | Send, then delete the draft in Typefully's UI inside the two-minute window. Confirm `available` dropped by one (the gap, reproduced). Run `pnpm send:reconcile` and confirm the row retires to `dropped` and `available` recovers. Capture the actual HTTP response for a deleted draft. | 0 |
| 3 | **Gap 3** | Send, then resend from the board inside the window. Confirm exactly one post goes live and whether cancellation refunds the publish. | 1 |
| 4 | Gap 2 | No live send needed — two real child processes appending to one ledger concurrently. | 0 |

Budget is not a constraint: the account has headroom and a second account is available if needed.
Test posts remain live on @bcd_kyle; a send is final.

**Step 2 is what confirms the `gone` branch.** If a deleted draft answers something other than 404,
the mapping in §1 is adjusted to whatever it actually returns before the branch is trusted. The code
ships with 404 as the only terminal signal precisely because that is the one we can reason about
without guessing.

## Testing

- Pure: the three-way state mapping, `awaitingPublish`/`awaitingArticlePublish` excluding retired
  rows, `ReconcilePublished`'s third branch.
- The resend gate, with a stubbed lookup for each of the three answers. The assertion that matters
  is that **the refusing paths never reach the sender** — a test that only checks the returned error
  message would pass while the post went out.
- `fileLock` under real concurrency: two child processes appending to one ledger. The test must fail
  when the lock is removed; a serialized-by-accident test proves nothing.
- Existing `typeMirror` coverage extends to the new status.

## Out of scope

- Cancelling a draft from anywhere other than the resend path. There is no operator-facing "cancel
  this scheduled post" action; adding one is a board feature, not a fix.
- Extending the file lock to stores that do not use `createSerializer`. A race on
  `renderings.json` or `translations.json` loses review work, not a live post — same primitive,
  different urgency, and widening the blast radius here buys nothing.
- Refunding or reconciling quota when a cancellation succeeds. Step 3 measures whether Typefully
  refunds; acting on the answer is a follow-up if the answer is surprising.
- Threading `dropped` into `pnpm status`'s funnel counts.

## Open question, to be closed by the live run

Whether a Typefully draft that failed at publish time is distinguishable from one still queued. A
`state` field exists on the draft resource (PR #76 observed `state:finished`), but its failure
vocabulary is unknown. If step 2's captured response reveals one, the `gone` branch accepts it as a
second terminal signal; if not, 404 remains the only one and a publish-time failure stays stuck —
narrower than today's bug, and documented rather than assumed away.
