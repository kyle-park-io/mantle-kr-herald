# Typefully follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four gaps PR #86's whole-branch review named — the ungated article send path, the untestable `sendToOutlet`, the missing request timeouts, and the second ledger's write race.

**Architecture:** One module becomes the single answer to "how many publishes are left" and both gates plus the banner read it, which removes the duplicated arithmetic instead of adding a third copy. `sendToOutlet` and the serialized-write logic each move behind a seam so the invariants that already broke once can be tested.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, React 18 for `web/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-typefully-followup-design.md`.
- Branch `fix/typefully-followup-seams-and-gaps`, which sits on top of PR #86 — everything that PR added is present and must keep working.
- Code, comments, commit messages and PR titles in **English**. `docs/ko/**` and dashboard copy in **Korean**.
- **Never `git add -A` or `git add .`.** A concurrent session has unrelated uncommitted work in this tree (`web/src/main.tsx`, `web/src/components/LoginPage.tsx`, `src/domain/auth/`, `tests/domain/auth/`, `docs/superpowers/specs/2026-07-29-dashboard-auth-options.md`). Stage by explicit path and verify with `git show --name-only` after each commit.
- Retry budget stays **3 attempts, 1000ms · 2000ms**. Timeouts are **per attempt**: **20000ms** for Typefully API calls, **120000ms** for the media download and the S3 `PUT`.
- Quota TTL stays **60 seconds**; in-flight counts are recomputed on **every** call.
- Low-quota threshold stays **3** (`LOW_PUBLISHING_QUOTA`).
- `pnpm test`, `pnpm typecheck` and `pnpm build:web` must pass before every commit.
- **Do not perform a real send.** The account has 6 publishes left this month and every X post is irreversible and public. `pnpm doctor --live` is read-only and safe.

---

### Task 1: Share the serialized-write helper with the article ledger

**Files:**
- Create: `src/shared/store/serialWrites.ts`
- Modify: `src/adapters/store/JsonDeliveryLedger.ts` (replace its private `queue`/`serial` with the shared helper)
- Modify: `src/adapters/store/JsonXArticleLedger.ts` (`add` becomes serialized)
- Test: `tests/shared/store/serialWrites.test.ts`, `tests/adapters/store/JsonXArticleLedger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createSerializer(): <T>(fn: () => Promise<T>) => Promise<T>` — each call returns a fresh serializer with its own private chain. One serializer per store instance.

PR #86 put a promise chain in `JsonDeliveryLedger` (see its `serial` method and the comment above it —
read them before you start, they explain the failure this prevents). `JsonXArticleLedger.add` has the
identical read-modify-write and no protection.

- [ ] **Step 1: Write the failing helper test**

Create `tests/shared/store/serialWrites.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSerializer } from "../../../src/shared/store/serialWrites";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("createSerializer", () => {
  it("runs jobs one at a time, in order", async () => {
    const serial = createSerializer();
    const order: string[] = [];
    const a = deferred();
    const first = serial(async () => { order.push("a:start"); await a.promise; order.push("a:end"); });
    const second = serial(async () => { order.push("b"); });
    // `b` must not have started while `a` is still in flight.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    a.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  // One failed write must not wedge every write after it on the same instance.
  it("runs the next job even after its predecessor rejects", async () => {
    const serial = createSerializer();
    const ran: string[] = [];
    const failing = serial(async () => { ran.push("a"); throw new Error("boom"); });
    await expect(failing).rejects.toThrow("boom");
    await serial(async () => { ran.push("b"); });
    expect(ran).toEqual(["a", "b"]);
  });

  it("still rejects to the caller that owns the failing job", async () => {
    const serial = createSerializer();
    await expect(serial(async () => { throw new Error("mine"); })).rejects.toThrow("mine");
    await expect(serial(async () => "ok")).resolves.toBe("ok");
  });

  it("gives each serializer its own chain", async () => {
    const one = createSerializer();
    const two = createSerializer();
    const gate = deferred();
    const blocked = one(async () => { await gate.promise; });
    // A job on a different serializer must not wait behind it.
    await expect(two(async () => "free")).resolves.toBe("free");
    gate.resolve();
    await blocked;
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/shared/store/serialWrites.test.ts`
Expected: FAIL — cannot resolve `../../../src/shared/store/serialWrites`.

- [ ] **Step 3: Write the helper**

Create `src/shared/store/serialWrites.ts`. Move the logic — and the reasoning in the comments —
out of `JsonDeliveryLedger.serial` rather than writing something new, so the explanation of *why*
travels with the code. It must keep both properties that method already has: a rejected predecessor
does not block its successor (the chain is continued with the same function in both slots of
`.then`), and the rejection still reaches the caller that owns it.

Generalise the doc comment: it currently names the delivery ledger's reconcile-vs-send overlap
specifically, and the helper now also serves the article ledger.

- [ ] **Step 4: Confirm the helper tests pass**

Run: `pnpm vitest run tests/shared/store/serialWrites.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing article-ledger concurrency test**

Create `tests/adapters/store/JsonXArticleLedger.test.ts`. Read
`tests/adapters/store/JsonDeliveryLedger.test.ts` first (PR #86 added a concurrency test there) and
mirror its harness — the same temp-directory setup and the same "both writes survive" shape:

```ts
it("keeps both rows when two adds overlap", async () => {
  const ledger = new JsonXArticleLedger(dir);
  await Promise.all([
    ledger.add({ itemId: "x:1", postId: "1", sentAt: "2026-07-29T00:00:00Z" }),
    ledger.add({ itemId: "x:2", postId: "2", sentAt: "2026-07-29T00:00:01Z" }),
  ]);
  const ids = new Set((await ledger.loadAll()).map((e) => e.itemId));
  expect(ids.has("x:1")).toBe(true);
  expect(ids.has("x:2")).toBe(true);
});
```

Both `add` calls go in the same `Promise.all` array literal so they genuinely overlap — sequential
`await`s would not reproduce the race and the test would pass against the broken version.

- [ ] **Step 6: Confirm it fails against the unserialized ledger**

Run: `pnpm vitest run tests/adapters/store/JsonXArticleLedger.test.ts`
Expected: FAIL — one of the two rows is missing.

**If it passes, stop and investigate before changing anything.** A concurrency test that passes
before the fix is not testing the fix, and this exact check is what proved the delivery-ledger fix
was real.

- [ ] **Step 7: Serialize both ledgers on the shared helper**

In `JsonXArticleLedger`, hold a serializer instance and wrap the body of `add`.
In `JsonDeliveryLedger`, delete the private `queue`/`serial` and use the shared helper for `add`
and `remove` — behaviour unchanged, one implementation.

- [ ] **Step 8: Hoist `serve.ts`'s article ledger to a module singleton**

Serialization is per instance, so it only protects writers that share one. `src/cli/serve.ts:268`
constructs a **new** `JsonXArticleLedger` inside `reconcilePublished`, i.e. a fresh chain on every
two-minute pass — which would make Step 7 do nothing in the dashboard process, the one place the
overlap actually happens.

Hoist it to a module-level `const` beside `deliveryLedger` (`serve.ts:82`), which is already shaped
that way for exactly this reason, and have `reconcilePublished` use that instance. Task 3 and Task 4
both need this same instance.

Leave `src/cli/send-reconcile.ts` alone — a short-lived CLI process has one writer and exits.

- [ ] **Step 9: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, including the delivery-ledger concurrency test PR #86 added.

- [ ] **Step 10: Commit**

```bash
git add src/shared/store/serialWrites.ts src/adapters/store/JsonDeliveryLedger.ts src/adapters/store/JsonXArticleLedger.ts src/cli/serve.ts tests/shared/store/serialWrites.test.ts tests/adapters/store/JsonXArticleLedger.test.ts
git commit -m "fix(store): serialize article-ledger writes on a shared helper"
```

---

### Task 2: `awaitingArticlePublish`

**Files:**
- Modify: `src/domain/send/awaitingPublish.ts` (add the article predicate beside the room one)
- Modify: `src/app/ReconcilePublished.ts` (its article loop uses the predicate instead of an inline test)
- Test: `tests/domain/send/awaitingPublish.test.ts`

**Interfaces:**
- Consumes: `isXUrl` from the same file.
- Produces: `awaitingArticlePublish<T extends { url?: string; postId?: string }>(row: T): row is T & { postId: string }` — true when an article row holds a Typefully draft id and no `x.com` url.

`ReconcilePublished`'s article loop decides pending-ness with an inline `isXUrl(row.url) || !row.postId`.
Task 3 needs the same judgement to count in-flight articles, and two definitions of "in flight" is
exactly what `awaitingPublish` was extracted to prevent for rooms.

- [ ] **Step 1: Write the failing test**

Append to `tests/domain/send/awaitingPublish.test.ts`:

```ts
describe("awaitingArticlePublish", () => {
  const row = (over: Record<string, unknown> = {}) => ({ itemId: "x:1", postId: "10104901", sentAt: "2026-07-29T00:00:00Z", ...over });

  /** What the article ledger holds right after a send: a Typefully draft id and no url. */
  it("is true for a row still holding a draft id", () => {
    expect(awaitingArticlePublish(row())).toBe(true);
  });

  it("is false once the row carries its x.com url", () => {
    expect(awaitingArticlePublish(row({ url: "https://x.com/bcd_kyle/status/2082141042959401225" }))).toBe(false);
  });

  it("is false with no postId — nothing was scheduled", () => {
    expect(awaitingArticlePublish(row({ postId: undefined }))).toBe(false);
  });
});
```

Add `awaitingArticlePublish` to the file's import list.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run tests/domain/send/awaitingPublish.test.ts`
Expected: FAIL — `awaitingArticlePublish` is not exported.

- [ ] **Step 3: Add the predicate**

Add it to `src/domain/send/awaitingPublish.ts`, next to `awaitingPublish`. Unlike the room
predicate it takes no outlet or status — an article ledger row exists only because an article was
sent, so holding a `postId` with no `x.com` url is the whole condition. Give it a doc comment saying
that, and pointing at `ReconcilePublished` and the headroom count as its two callers.

- [ ] **Step 4: Use it in `ReconcilePublished`**

Replace the article loop's inline condition with the predicate. Behaviour is identical — this is a
pure substitution, so the existing `tests/app/reconcilePublished.test.ts` must pass untouched.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/domain/send/awaitingPublish.test.ts tests/app/reconcilePublished.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/send/awaitingPublish.ts src/app/ReconcilePublished.ts tests/domain/send/awaitingPublish.test.ts
git commit -m "refactor(send): extract awaitingArticlePublish so reconcile and the gate agree"
```

---

### Task 3: One module answers "how much headroom is left"

**Files:**
- Create: `src/cli/publishHeadroom.ts`
- Delete: `src/cli/loadQuota.ts`, `src/cli/typefullyQuotaReader.ts`
- Modify: `src/app/SendChannels.ts` (the 12th parameter's type; the gate stops doing arithmetic)
- Modify: `src/cli/serve.ts`, `src/cli/send-channels.ts`, `src/adapters/web/apiHandlers.ts`, `web/src/api.ts`, `web/src/types.ts`, `web/src/components/OutletBoard.tsx`
- Test: `tests/cli/publishHeadroom.test.ts` (the old `tests/cli/loadQuota.test.ts` and `tests/cli/typefullyQuotaReader.test.ts` move here), `tests/app/sendChannels.test.ts`, `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `awaitingPublish`, `awaitingArticlePublish` (Task 2); `TypefullyQuota`/`PublishingQuota`; `loadTypefullyConfig`.
- Produces:
  ```ts
  export interface Headroom {
    remaining: number;   // the account's raw remaining publishes, for display
    used: number;        // publishes already spent — the banner's denominator is used + remaining
    inFlight: number;    // scheduled but unconfirmed, across BOTH ledgers
    available: number;   // remaining − inFlight; may be negative, clamp only for display
    resetsAt: string;
  }
  export interface HeadroomView { headroom?: Headroom; error?: string }
  export function makeReadHeadroom(deliveryLedger, articleLedger, deps?): () => Promise<Headroom>
  export function makeLoadHeadroom(deliveryLedger, articleLedger, deps?): () => Promise<HeadroomView>
  export function headroomReader(targets, deliveryLedger, articleLedger): (() => Promise<Headroom>) | undefined
  ```
  `makeReadHeadroom` throws on failure (the gate's contract, which already catches). `makeLoadHeadroom`
  answers `{ error }` instead (the board's contract, always HTTP 200). `headroomReader` returns
  `undefined` when X is not a target or Typefully is unconfigured — the guard inherited verbatim from
  the deleted `quotaReader`.

**This is the largest task and it must land in one commit-set**: a half-migration does not typecheck,
because deleting `loadQuota.ts`/`typefullyQuotaReader.ts` breaks their importers immediately.

**Read before starting:** `src/cli/loadQuota.ts` and `src/cli/typefullyQuotaReader.ts` (you are
replacing both — carry their doc comments across, they explain the TTL, the never-cache-an-error rule
and the opt-in guard), and `src/app/SendChannels.ts`'s gate block.

- [ ] **Step 1: Write the failing headroom tests**

Create `tests/cli/publishHeadroom.test.ts`. Port every test from `tests/cli/loadQuota.test.ts` and
`tests/cli/typefullyQuotaReader.test.ts` — they cover behaviour that must survive — then add:

```ts
it("counts in-flight rows from BOTH ledgers", async () => {
  const delivery = fakeDeliveryLedger([sentRow({ outletId: "x-post", postId: "10104901" })]);
  const article = fakeArticleLedger([{ itemId: "x:9", postId: "10097410", sentAt: "2026-07-29T00:00:00Z" }]);
  const read = makeReadHeadroom(delivery, article, { readQuota: async () => ({ used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" }), loadConfig: () => ({ apiKey: "K", socialSetId: "42" }) });
  const h = await read();
  expect(h.inFlight).toBe(2);
  expect(h.available).toBe(4);
  expect(h.remaining).toBe(6);
  // The banner's denominator would be lost without it.
  expect(h.used).toBe(9);
});

it("recomputes in-flight on every call while the quota stays cached", async () => {
  // Same fake-ledger array mutated between calls; assert `inFlight` moves and the quota fetch does not repeat.
});

it("leaves available negative rather than clamping — the caller clamps for display", async () => {
  // remaining 1, two in-flight rows -> available === -1
});
```

Write `fakeDeliveryLedger` / `fakeArticleLedger` as thin locals returning a mutable array, so the
"recomputes per call" test can mutate between calls.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run tests/cli/publishHeadroom.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `publishHeadroom.ts`**

`makeReadHeadroom` keeps `loadQuota.ts`'s structure: the Typefully read behind the 60s TTL, both
in-flight counts recomputed on every call. `available = remaining − inFlight`, unclamped.

`makeLoadHeadroom` wraps it and converts a throw into `{ error }`, never caching the failure.

`headroomReader(targets, deliveryLedger, articleLedger)` reproduces `quotaReader`'s two `undefined`
paths exactly — X not among targets, and `loadTypefullyConfig()` throwing.

- [ ] **Step 4: Confirm the headroom tests pass**

Run: `pnpm vitest run tests/cli/publishHeadroom.test.ts`

- [ ] **Step 5: Rewire `SendChannels`**

Change the 12th constructor parameter's type to `() => Promise<Headroom>` and rename it to match.
The gate block then:

- keeps the `needed` computation and the unverified-assumption comment above it **verbatim** — that
  comment is load-bearing documentation, do not drop it in the edit;
- **deletes** its own `inFlight` line and its `available` subtraction, comparing `needed > h.available`
  directly;
- keeps `quotaBlocked: { needed, available, resetsAt }` exactly as it is, so nothing downstream changes;
- keeps the catch that logs and proceeds.

Update `tests/app/sendChannels.test.ts`'s quota helpers to return a `Headroom` instead of a
`PublishingQuota`. The existing assertions must survive — in particular the test that in-flight rows
reduce the headroom now proves it through the reader rather than through `SendChannels`' internals,
so make sure that test still fails if the arithmetic is wrong.

- [ ] **Step 6: Rewire the callers**

`serve.ts` and `send-channels.ts` build the reader with `headroomReader(...)` and now need a
`JsonXArticleLedger` instance to pass it. In `serve.ts`, use the module-level singleton Task 1
hoisted — do **not** construct a second one, because a second instance carries a second serializer
chain and the two would race each other, undoing Task 1 inside the one process where it matters.

The board dependency keeps the name `loadQuota` and its always-200 `{ …, error? }` contract; only the
payload widens. Update `ApiDeps`, `web/src/api.ts`, the `web/src/types.ts` mirror and `OutletBoard.tsx`
to the new shape. The banner's arithmetic **moves out of the component** — it now renders
`headroom.available`, `headroom.inFlight` and `used + remaining` directly instead of subtracting.
Amber still keys off `available`, and an unreadable headroom still omits the banner entirely.

- [ ] **Step 7: Delete the replaced modules and their tests**

```bash
git rm src/cli/loadQuota.ts src/cli/typefullyQuotaReader.ts tests/cli/loadQuota.test.ts tests/cli/typefullyQuotaReader.test.ts
```

Confirm nothing still imports them: `grep -rn "loadQuota\|typefullyQuotaReader" src/ web/src/ tests/`
should only match the board dependency *named* `loadQuota`, not the deleted modules.

- [ ] **Step 8: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build:web`

- [ ] **Step 9: Commit**

Stage every touched path explicitly, then:

```bash
git commit -m "refactor(quota): one module answers how much headroom is left"
```

---

### Task 4: Gate `send:x-article` on the same headroom

**Files:**
- Modify: `src/app/SendXArticle.ts`
- Modify: `src/cli/send-x-article.ts`
- Test: `tests/app/sendXArticle.test.ts`

**Interfaces:**
- Consumes: `Headroom`, `headroomReader` (Task 3).
- Produces: `SendXArticle.run` result gains `quotaBlocked?: { needed: number; available: number; resetsAt: string }`, the same shape `SendChannelsResult` uses.

`SendXArticle` currently creates one Typefully draft per approved article, unbounded and ungated.

- [ ] **Step 1: Write the failing tests**

Read `tests/app/sendXArticle.test.ts` first and reuse its existing fixtures. Add:

```ts
const headroomOf = (available: number) => async () => ({ remaining: available, used: 15 - available, inFlight: 0, available, resetsAt: "2026-08-01T00:00:00+09:00" });

describe("SendXArticle — publishing quota gate", () => {
  it("sends nothing when the run needs more than the headroom allows", async () => {
    // two approved article items, headroom 1
    const result = await runWith(headroomOf(1), { items: 2 });
    expect(result.sent).toBe(0);
    // A refusal is an account state, not a fault.
    expect(result.failed).toBe(0);
    expect(result.quotaBlocked).toEqual({ needed: 2, available: 1, resetsAt: "2026-08-01T00:00:00+09:00" });
  });

  it("sends normally when the headroom covers the run", async () => {
    const result = await runWith(headroomOf(6), { items: 2 });
    expect(result.sent).toBe(2);
    expect(result.quotaBlocked).toBeUndefined();
  });

  // Counting must exclude what would be skipped anyway, or the gate refuses runs that would have sent nothing.
  it("counts only the items this run would actually send", async () => {
    const result = await runWith(headroomOf(1), { items: 2, alreadySent: ["x:1"] });
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  it("never calls the reader when the run has no articles to send", async () => {
    let called = 0;
    await runWith(async () => { called += 1; return headroomOf(6)(); }, { items: 0 });
    expect(called).toBe(0);
  });

  // A monitoring call must not become a new way for delivery to fail.
  it("sends anyway when the reader throws", async () => {
    const result = await runWith(async () => { throw new Error("network down"); }, { items: 1 });
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });
});
```

Write `runWith` as a thin local over the file's existing fixture builders.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run tests/app/sendXArticle.test.ts`

- [ ] **Step 3: Add the gate**

Add an optional last constructor parameter `headroom?: () => Promise<Headroom>`.

The invariant to satisfy — decide the placement yourself after reading `run()`:

- The count must be of items this run **would actually send** — approved, matching `ids`, `isArticle`,
  and not already in the ledger. Counting anything else refuses runs that would have sent nothing.
  `run()` currently decides those things inside its loop, so you will need the count before the loop;
  extract the filter rather than duplicating its conditions, for the reason `SendChannels.roomsFor`
  exists — a second copy drifts, and a drifted count either refuses a legal run or lets an over-quota
  one through.
- The check happens **before any draft is created**, and refuses the whole run rather than part of it.
- `failed` stays 0 and nothing is pushed to any failure list.
- A throwing reader logs and proceeds.

- [ ] **Step 4: Confirm the tests pass**

Run: `pnpm vitest run tests/app/sendXArticle.test.ts`

- [ ] **Step 5: Wire the CLI and report the refusal**

`src/cli/send-x-article.ts` builds the reader with `headroomReader(["x"], deliveryLedger, articleLedger)`
— it will need a `JsonDeliveryLedger` instance it does not currently construct, since headroom spans
both ledgers.

Print the refusal in the same voice `send-channels.ts` uses for its own — an English `⚠` line naming
the needed count, the available count and the reset, and saying nothing was sent.

- [ ] **Step 6: Full verification**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/app/SendXArticle.ts src/cli/send-x-article.ts tests/app/sendXArticle.test.ts
git commit -m "feat(send): gate x-article sends on the publishing headroom"
```

---

### Task 5: `makeSendToOutlet` — a seam for the resend invariant

**Files:**
- Create: `src/cli/sendToOutlet.ts`
- Modify: `src/cli/serve.ts` (the inline `sendToOutlet` becomes one factory call)
- Test: `tests/cli/sendToOutlet.test.ts`

**Interfaces:**
- Consumes: `Headroom`/`headroomReader` (Task 3); `SendChannels`; the four stores.
- Produces: `makeSendToOutlet(deps): (itemId: string, type: string, outletId: string, resend?: boolean) => Promise<{ sent: number; failed: number; error?: string }>` — the same signature `ApiDeps.sendToOutlet` already declares, so `apiHandlers.ts` is untouched.

**Read `src/cli/serve.ts`'s current `sendToOutlet` in full before you start**, including the two doc
comments above it. You are moving it, not rewriting it: the behaviour, every message string and every
comment must survive the move unchanged.

`deps` carries only what is module state or reads the environment — the four stores
(`formattingStore`, `deliveryLedger`, `translationStore`, `overrideStore`) plus the env/IO functions
(`chatIds`, `xMaxWeighted`, `senders`, `headroom`, `recorder`, `archiver`), each defaulting to the
real implementation. `outletById`, `deliveredByChannelSender`, `deliveryKey`, `outletsForChannel` and
`SendChannels` stay plain imports — injecting them would push the list past a dozen and force every
test to restate the real outlet definitions.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/sendToOutlet.test.ts`. The invariant under test: **a resend removes the ledger row
first, so every path that ends without sending must put it back — and the path that does send must
not.**

```ts
describe("makeSendToOutlet — the resend ledger restore", () => {
  it("restores the row when the send is refused for quota", async () => {
    // headroom that refuses; assert the previous row is back in the ledger and the error names the quota
  });

  it("restores the row when nothing is sent for any other reason", async () => {
    // e.g. the room is already delivered; assert the row is back
  });

  it("restores the row when the send throws", async () => {
    // sender throws; assert the row is back and failed === 1
  });

  // The complement, and the one a careless fix breaks: a successful resend must leave exactly one row.
  it("does not re-add the previous row on a successful send", async () => {
    // assert the ledger holds one row for the key, describing the NEW send
  });
});

describe("makeSendToOutlet — guards that return before any send", () => {
  it("rejects an unknown outlet", async () => { /* error names the outlet id, sender never called */ });
  it("rejects a room that is not posted by a bot", async () => { /* … */ });
  it("rejects a room whose chat id env is unset", async () => { /* … */ });
  it("rejects a resend for a room nothing has been sent to", async () => { /* … */ });
});
```

Fill each body using fakes for the four stores and a recording fake sender. For the outlet-dependent
cases use real outlet ids from `src/domain/outlet/models.ts` — read it and pick an X room, a Telegram
room with a `chatIdEnv`, and a room that is not bot-delivered.

Assert on the **ledger's final contents**, not on call counts — the bug this guards against is a
missing row, and a call-count assertion would not have caught the original defect.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run tests/cli/sendToOutlet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the function behind the factory**

Create `src/cli/sendToOutlet.ts` with `makeSendToOutlet(deps)`. Move the body across verbatim,
replacing each closed-over singleton with the corresponding dep. Carry both doc comments.

- [ ] **Step 4: Confirm the tests pass**

Run: `pnpm vitest run tests/cli/sendToOutlet.test.ts`
Expected: PASS, 8 tests.

**If the "does not re-add on success" test passes trivially, check it would fail against a version
that always restores** — add a temporary `add(previous)` on the success path, watch it fail, then
remove it. Say what you observed in your report.

- [ ] **Step 5: Reduce `serve.ts` to one call**

Replace the inline definition with a `makeSendToOutlet({ … })` call. `deps.sendToOutlet` in the
`ApiDeps` object is unchanged.

- [ ] **Step 6: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build:web`

- [ ] **Step 7: Commit**

```bash
git add src/cli/sendToOutlet.ts src/cli/serve.ts tests/cli/sendToOutlet.test.ts
git commit -m "refactor(serve): extract sendToOutlet so the resend restore is testable"
```

---

### Task 6: Per-attempt request timeouts

**Files:**
- Modify: `src/adapters/send/typefullyFetch.ts`
- Modify: `src/adapters/send/TypefullyMedia.ts` (the download and the S3 `PUT` opt into the long budget)
- Test: `tests/adapters/send/typefullyFetch.test.ts`

**Interfaces:**
- Consumes: `TypefullyCallOptions`, `createTypefullyFetch` as they exist today.
- Produces: `TypefullyCallOptions` gains `timeoutMs?: number`; exports `API_TIMEOUT_MS = 20000` and `MEDIA_TIMEOUT_MS = 120000`.

**Read the retry loop in full first.** A timeout must not weaken the retry asymmetry that PR #86
built: an abort is a fetch rejection, so it already flows into the non-idempotent branch that throws
*"the request may still have been processed; check the Typefully queue before re-running"*. That is
exactly right for a timeout — the server may have created the draft and only the response was lost —
so the requirement here is to **pin that behaviour with a test**, not to add new handling for it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/send/typefullyFetch.test.ts`:

```ts
describe("createTypefullyFetch — request timeouts", () => {
  /** Captures the `signal` each attempt was given, so the test can assert one exists per attempt. */
  const capturing = (statuses: number[]) => {
    const signals: (AbortSignal | undefined)[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return { ok: true, status: statuses.shift() ?? 200 } as Response;
    }) as unknown as typeof fetch;
    return { fn, signals };
  };

  it("passes an abort signal on every attempt", async () => {
    const { fn, signals } = capturing([503, 503, 200]);
    await createTypefullyFetch(fn, async () => {}, () => {})("https://api.typefully.com/v2/me");
    expect(signals).toHaveLength(3);
    // A single signal reused across attempts would already be aborted on attempt 2.
    expect(new Set(signals).size).toBe(3);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it("retries an idempotent call whose attempt timed out", async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const res = await createTypefullyFetch(fn, async () => {}, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  // The canonical case for that message: the server may have created the draft and only the
  // response was lost.
  it("does NOT retry a timed-out draft create, and says the request may have landed", async () => {
    let calls = 0;
    const fn = (async () => { calls += 1; throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    const call = createTypefullyFetch(fn, async () => {}, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    await expect(call).rejects.toThrow(/may still have been processed/);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run tests/adapters/send/typefullyFetch.test.ts`
Expected: FAIL — the first test finds no `signal` on `init`.

- [ ] **Step 3: Add the timeout**

Add `timeoutMs` to `TypefullyCallOptions`, defaulting to `API_TIMEOUT_MS`. Build a fresh
`AbortSignal.timeout(timeoutMs)` **inside** the retry loop, per attempt — a signal created once
outside would already be aborted on the second attempt, which is what the `new Set(signals).size`
assertion pins.

Merge it into the `init` passed to `fetchFn` without discarding a caller-supplied `signal` if one is
ever present.

- [ ] **Step 4: Give the media paths the long budget**

In `TypefullyMedia`, pass `{ timeoutMs: MEDIA_TIMEOUT_MS }` on the source download and the S3 `PUT`.
Leave `media/upload` and the status poll on the API default — they are small JSON calls.

- [ ] **Step 5: Confirm the tests pass**

Run: `pnpm vitest run tests/adapters/send/typefullyFetch.test.ts tests/adapters/send/typefullyMedia.test.ts`
Expected: PASS. If a media test now hangs, it is waiting on a real timer — pass `async () => {}` as
its `sleep` argument; do not change what it asserts.

- [ ] **Step 6: Full verification**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/adapters/send/typefullyFetch.ts src/adapters/send/TypefullyMedia.ts tests/adapters/send/typefullyFetch.test.ts
git commit -m "feat(send): give every Typefully attempt a request timeout"
```

---

### Task 7: Document the article gate

**Files:**
- Modify: `docs/ko/setup/channels.md` (the Y-5 subsection)
- Modify: `docs/ko/team-runbook.md` (the `send:x-article` step)

**Interfaces:**
- Consumes: nothing. Documentation only.

PR #86 documented, in Korean, that `pnpm send:x-article` is **not** quota-gated and that its
scheduled drafts are invisible to the gate, telling the operator to check `pnpm doctor --live` before
a batch. Tasks 3 and 4 make both statements false.

- [ ] **Step 1: Correct the claims**

Read the current Y-5 text and the runbook's `send:x-article` step, then rewrite the affected
sentences: the article path is now gated on the same headroom, and its scheduled drafts now count
against what the board and `send:channels` will allow. Remove the "check doctor first" workaround —
it existed only because the gap existed.

Keep it to a correction. Do not restate the whole quota explanation; the Y-5 prose around it already
covers the shared behaviour.

- [ ] **Step 2: Verify every quoted string**

Any message or number the docs quote must match the source. Check the new `send:x-article` refusal
line against `src/cli/send-x-article.ts`, and the banner against `OutletBoard.tsx` — Task 3 moved the
banner's arithmetic, so re-read it rather than trusting the existing text.

- [ ] **Step 3: Commit**

```bash
git add docs/ko/setup/channels.md docs/ko/team-runbook.md
git commit -m "docs(ko): the article path is quota-gated now"
```

---

## Wrap-up

- [ ] **Full verification**

Run: `pnpm test && pnpm typecheck && pnpm build:web && pnpm doctor --live`
Expected: all green; the Typefully live check still reports the account quota.

- [ ] **Open the PR**

Base it on `fix/typefully-quota-and-resilience` while PR #86 is open, or on `main` once #86 has
merged. Title: `fix(send): close the article quota gap, add test seams and request timeouts`.

---

## Self-Review

**Spec coverage.** Spec §1 (`makeSendToOutlet`) → Task 5. §2 (shared serialized writes) → Task 1,
which also covers the `JsonXArticleLedger` race from the spec's motivation. §3 (headroom unification,
`awaitingArticlePublish`, the `SendChannels` type change, `SendXArticle`) → Tasks 2, 3 and 4. §4
(per-attempt timeouts, and pinning the timed-out-draft-create behaviour) → Task 6. The spec's
motivation section notes PR #86's docs assert the article path is ungated → Task 7. Nothing in the
spec is unclaimed.

**Type consistency.** `Headroom` is defined once in Task 3 and consumed under that exact name by
Tasks 4 and 5. `HeadroomView` is the board's always-200 payload; the `ApiDeps` field keeps the name
`loadQuota` deliberately, which Task 3 states. `awaitingArticlePublish` is defined in Task 2 and used
in Task 3. `quotaBlocked: { needed, available, resetsAt }` is the same shape in `SendChannelsResult`
and the new `SendXArticle` result. `createSerializer` from Task 1 is used by both ledgers in that
same task.

**Ordering.** Tasks 1, 2 and 6 are independent. Task 3 needs 2; Tasks 4 and 5 need 3; Task 7 needs 3
and 4. Numeric order satisfies every dependency.

**A note on this plan's style.** PR #86's plan embedded complete implementations, and three of that
branch's review findings were defects in those snippets that implementers faithfully reproduced —
including a quota check placed between a ledger `remove` and its restore. This plan gives test code
concretely (that worked) but states implementation requirements as invariants plus the files to read
where placement matters, so the implementer reasons about the surrounding control flow instead of
trusting a snippet's position.
