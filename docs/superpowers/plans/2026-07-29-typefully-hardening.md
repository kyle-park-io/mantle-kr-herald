# Typefully Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three gaps PR #86/#89 left open — a stuck `inFlight` row that permanently eats publishing capacity, a resend that double-posts a still-queued draft, and a cross-process ledger race — then verify all three with one live send.

**Architecture:** Hexagonal TS. `TypefullyDraftLookup` stops collapsing "the draft is gone" into "still scheduled" and returns a three-way state; `ReconcilePublished` retires the terminal case to a new `dropped` delivery status that falls out of the in-flight count; the board's resend path consults the *same* lookup and cancels the original draft before re-sending; a `withFileLock` primitive wraps the two send ledgers' read-modify-write so two processes cannot lose each other's rows.

**Tech Stack:** TypeScript ESM, `zod` (only runtime dep), native `fetch`, vitest, React + Vite + Tailwind v4 in `web/` (build-time devDeps only).

**Spec:** `docs/superpowers/specs/2026-07-29-typefully-hardening-design.md` — read it before Task 1. It carries the reasoning; this plan carries the sequence.

## Global Constraints

- **Runtime dependencies stay `zod`-only.** No new package for locking, retries, or HTTP. `node:fs`, `node:fs/promises`, `node:path` and native `fetch` are the toolbox.
- **The `web/` frontend cannot import from `src/`.** `web/tsconfig.json` includes only `web/src`. Any domain vocabulary the dashboard needs is hand-mirrored in `web/src/types.ts` and pinned by `tests/web/typeMirror.test.ts`. Adding a union member on one side without the other passes both typechecks and is caught only by that test.
- **Code, comments, commit messages and PR titles are English. User-facing dashboard/CLI strings and `docs/ko/**` are Korean.**
- **Every test must be able to fail.** Before accepting a test, break the implementation it covers and confirm the test goes red. This has been the recurring defect class in this repo: assertions that could not fail (a no-op NFC assertion, an unpinned threshold, a length formula measuring the wrong string).
- **No live send happens before Task 7.** Tasks 1–6 are offline. A send is irreversible and public.
- Run `pnpm test`, `pnpm typecheck` and `pnpm typecheck:web` before each commit. `pnpm build:web` too for any task touching `web/`.
- `main` is branch-protected (`test` CI required). Work on `fix/typefully-hardening`, which already exists and carries the spec commit.

## File Structure

**New:**
- `src/domain/send/draftState.ts` — the three-way `DraftState` union. Pure, zero deps; shared by the adapter that produces it and the two use-cases that consume it.
- `src/shared/store/fileLock.ts` — `withFileLock(path, fn)`. Pure I/O primitive, no knowledge of ledgers.
- `tests/shared/store/fileLock.test.ts`, `tests/shared/store/fileLock.child.mjs` — the child-process concurrency harness.

**Modified:**
- `src/adapters/send/TypefullyDraftLookup.ts` — returns `DraftState`; gains `cancel()`.
- `src/ports/DraftLookup.ts` (new) — the narrow port both the reconcile and the resend depend on.
- `src/domain/delivery/models.ts` — `status` union gains `"dropped"`; a pure predicate for "this room already received it".
- `src/domain/send/awaitingPublish.ts` — article rows exclude retired ones.
- `src/adapters/store/JsonDeliveryLedger.ts`, `src/adapters/store/JsonXArticleLedger.ts` — retired rows leave `loadKeys()`; writes take the file lock.
- `src/app/ReconcilePublished.ts` — the third branch.
- `src/cli/sendToOutlet.ts` — look-before-cancel on resend.
- `src/cli/serve.ts` — wire the lookup into the resend path.
- `src/cli/send-reconcile.ts` — unchanged behaviour, new adapter shape.
- `src/cli/clean.ts` — sweep abandoned `.lock` files.
- `src/adapters/web/board.ts`, `web/src/types.ts`, `web/src/components/OutletCard.tsx` — render the retired state.
- `CHANGELOG.md`, `docs/ko/team-runbook.md`.

---

### Task 1: `published()` answers three ways instead of two

**Files:**
- Create: `src/domain/send/draftState.ts`
- Create: `src/ports/DraftLookup.ts`
- Modify: `src/adapters/send/TypefullyDraftLookup.ts`
- Test: `tests/adapters/send/typefullyDraftLookup.test.ts`

**Read first:** `src/adapters/send/TypefullyDraftLookup.ts` in full (33 lines) and `src/adapters/send/typefullyFetch.ts` — `createTypefullyFetch` already wraps retries and timeouts, and it is what decides whether a failed request throws or returns a non-ok `Response`. The mapping below depends on knowing which.

**Interfaces:**
- Produces: `type DraftState = { state: "published"; xUrl?: string; xId?: string; articleUrl?: string; articleId?: string } | { state: "scheduled" } | { state: "gone" }` from `src/domain/send/draftState.ts`.
- Produces: `interface DraftLookup { published(draftId: string): Promise<DraftState>; cancel(draftId: string): Promise<boolean> }` in `src/ports/DraftLookup.ts`. `cancel` lands in Task 5; declare the whole port now so Task 4 and Task 5 depend on one file.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/send/typefullyDraftLookup.test.ts`, and **replace** the existing `"returns {} on a non-ok response (still scheduled / unknown draft)"` test — its name encodes the bug.

```ts
it("reports a published draft", async () => {
  const { fn } = fakeFetch({ x_published_url: "https://x.com/a/status/9", x_article_published_url: null });
  expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({
    state: "published", xUrl: "https://x.com/a/status/9", xId: "9", articleUrl: undefined, articleId: undefined,
  });
});

it("reports a draft with no published url as still scheduled", async () => {
  const { fn } = fakeFetch({ x_published_url: null, x_article_published_url: null });
  expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
});

it("reports a 404 as gone — the draft was deleted and will never publish", async () => {
  const { fn } = fakeFetch({}, false, 404);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "gone" });
});

it("reports a 500 as still scheduled — an outage must never retire a queued draft", async () => {
  const { fn } = fakeFetch({}, false, 500);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
});

it("reports a 403 as still scheduled", async () => {
  const { fn } = fakeFetch({}, false, 403);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test tests/adapters/send/typefullyDraftLookup.test.ts`
Expected: FAIL — the adapter returns bare objects, not a tagged union.

- [ ] **Step 3: Implement**

Invariants:
- **404 is the only terminal answer.** Every other non-ok status maps to `scheduled`. Being wrong in the `gone` direction retires a row that was going to publish, which is how a live post becomes invisible to the ledger and gets sent twice; being wrong in the `scheduled` direction only leaves a row stuck, which is today's behaviour.
- **A thrown request stays thrown.** `ReconcilePublished` already catches and counts it as pending; do not swallow it here and turn a network failure into a state claim.
- The published/scheduled split keeps its current rule: a `x_published_url` or `x_article_published_url` present and non-null means published.
- `parseTweetId`/`parseArticleId` usage is unchanged.
- `DraftState` lives in `src/domain/send/draftState.ts` because the use-cases switch on it and must not import an adapter.
- `DraftLookup` in `src/ports/DraftLookup.ts` declares both `published` and `cancel`; the adapter implements `published` now and Task 5 adds `cancel`. Do not add `implements DraftLookup` to the class until `cancel` exists, or this task will not compile.

- [ ] **Step 4: Run the tests and the typechecks**

Run: `pnpm test tests/adapters/send/typefullyDraftLookup.test.ts && pnpm typecheck`
Expected: PASS. Other suites will still fail to typecheck against the new return shape — that is Task 4's job. If `pnpm typecheck` reports errors *only* in `src/app/ReconcilePublished.ts` and its test, proceed; anything else means the union leaked somewhere unplanned.

- [ ] **Step 5: Verify the test can fail**

Change the 404 mapping to also catch 500, run the suite, confirm the "reports a 500" test goes red, then revert.

- [ ] **Step 6: Commit**

```bash
git add src/domain/send/draftState.ts src/ports/DraftLookup.ts src/adapters/send/TypefullyDraftLookup.ts tests/adapters/send/typefullyDraftLookup.test.ts
git commit -m "feat(send): tell a deleted Typefully draft apart from a queued one"
```

---

### Task 2: A retired row is `dropped`, and stops meaning "already received"

**Files:**
- Modify: `src/domain/delivery/models.ts`
- Modify: `src/domain/send/awaitingPublish.ts`
- Modify: `src/adapters/store/JsonDeliveryLedger.ts:40-42` (`loadKeys`)
- Modify: `src/adapters/store/JsonXArticleLedger.ts:5-10,20-22` (`XArticleSentEntry`, `loadKeys`)
- Test: `tests/domain/send/awaitingPublish.test.ts`, `tests/adapters/store/` (new file for the ledger), `tests/app/sendChannels.test.ts`

**Read first:** `src/adapters/store/JsonDeliveryLedger.ts` in full — its `loadAll` doc comment explains why writes are based on the legacy-aware read, and why a row silently leaving `loadKeys()` becomes a duplicate live post. The change here is the *deliberate* version of exactly what that comment warns about, so the reasoning must stay intact.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DeliveryEntry["status"]` includes `"dropped"`; `XArticleSentEntry.droppedAt?: string`; `loadKeys()` on both ledgers excludes retired rows; `awaitingArticlePublish` excludes rows carrying `droppedAt`.

- [ ] **Step 1: Write the failing tests**

New `tests/adapters/store/jsonDeliveryLedger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDeliveryLedger } from "../../../src/adapters/store/JsonDeliveryLedger";
import type { DeliveryEntry } from "../../../src/domain/delivery/models";

const row = (o: Partial<DeliveryEntry> = {}): DeliveryEntry => ({
  itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "t", by: "auto", ...o,
});

describe("JsonDeliveryLedger.loadKeys", () => {
  it("omits a dropped row so the room can be sent to again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const ledger = new JsonDeliveryLedger(dir);
    await ledger.add(row({ status: "dropped" }));
    expect(await ledger.loadKeys()).toEqual(new Set());
    // The row itself is still there — the board explains what happened.
    expect(await ledger.loadAll()).toHaveLength(1);
  });

  it("keeps sent and delivered rows in the key set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const ledger = new JsonDeliveryLedger(dir);
    await ledger.add(row({ status: "sent" }));
    await ledger.add(row({ outletId: "tg-dev", status: "delivered" }));
    expect(await ledger.loadKeys()).toEqual(new Set(["x:1:x:x-post", "x:1:x:tg-dev"]));
  });

  it("replaces a dropped row when the room is sent to again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ledger-"));
    const ledger = new JsonDeliveryLedger(dir);
    await ledger.add(row({ status: "dropped" }));
    await ledger.add(row({ status: "sent", postId: "99" }));
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "sent", postId: "99" });
  });
});
```

Append to `tests/domain/send/awaitingPublish.test.ts`:

```ts
it("a dropped delivery row is not awaiting publication", () => {
  expect(awaitingPublish({ outletId: "x-post", status: "dropped", postId: "123" })).toBe(false);
});

it("an article row marked dropped is not awaiting publication", () => {
  expect(awaitingArticlePublish({ postId: "123", droppedAt: "2026-07-29T00:00:00.000Z" })).toBe(false);
});

it("an article row with no droppedAt is still awaiting publication", () => {
  expect(awaitingArticlePublish({ postId: "123" })).toBe(true);
});
```

Append to `tests/app/sendChannels.test.ts` — follow the existing harness in that file for building a run; the assertion that matters:

```ts
it("sends to a room whose only ledger row was dropped", async () => {
  // A dropped row means the draft was deleted before it published: nothing reached the room, so
  // withholding here would strand it forever — the opposite of what retiring the row is for.
  // Build the run with one approved x rendering and a ledger holding
  // { itemId, type, outletId: "x-post", status: "dropped" }.
  // Expect: sent === 1, skipped === 0.
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm test tests/adapters/store/jsonDeliveryLedger.test.ts tests/domain/send/awaitingPublish.test.ts tests/app/sendChannels.test.ts`
Expected: FAIL — `"dropped"` is not assignable to `DeliveryEntry["status"]`.

- [ ] **Step 3: Implement**

Invariants:
- `DeliveryEntry.status` becomes `"sent" | "delivered" | "dropped"`. Extend the existing doc comment: `sent` is an observation and is never reversed; `delivered` is a human's reversible claim; **`dropped` is a scheduled send that provably never reached the room.**
- Export one pure predicate from `src/domain/delivery/models.ts` for "this row means the room already has this copy" and use it in `loadKeys()`. One predicate, not an inline `!== "dropped"` at each site — this is the same rule as `sendBlock` and `isStale`: the moment two places decide it independently they can disagree, and disagreement here is a duplicate live post.
- `loadAll()` keeps returning every row, retired ones included. The board reads `loadAll`.
- `JsonXArticleLedger.loadKeys()` excludes rows with `droppedAt`; `loadAll()` does not.
- `awaitingPublish` needs no change (it already requires `status === "sent"`), but the new test pins that. `awaitingArticlePublish` gains the `droppedAt` exclusion.
- **Do not touch `roomsFor`/`planRooms` in `SendChannels`.** They consume `loadKeys()`; fixing the source is the whole point.

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS except `src/adapters/web/board.ts` / `web/` mirror errors on the widened union — those are Task 3.

- [ ] **Step 5: Verify the tests can fail**

Revert the `loadKeys()` exclusion, run the suite, confirm the dropped-row tests and the `sendChannels` test go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/domain/delivery/models.ts src/domain/send/awaitingPublish.ts src/adapters/store/JsonDeliveryLedger.ts src/adapters/store/JsonXArticleLedger.ts tests/
git commit -m "feat(send): add a dropped delivery status that frees the room and the quota"
```

---

### Task 3: The board says what happened

**Files:**
- Modify: `src/adapters/web/board.ts:25`
- Modify: `web/src/types.ts:252`
- Modify: `web/src/components/OutletCard.tsx:648-649,885`
- Test: `tests/web/typeMirror.test.ts`, `tests/adapters/web/` board tests

**Read first:** `tests/web/typeMirror.test.ts`'s header comment — it explains why the mirror exists and what passes both typechecks while silently drifting. And `web/src/components/OutletCard.tsx:640-700` for how `sent`/`delivered` currently drive the row's affordances.

**Interfaces:**
- Consumes: `DeliveryEntry["status"]` from Task 2.
- Produces: `BoardRow.deliveryStatus?: "sent" | "delivered" | "dropped"` on both sides of the mirror.

- [ ] **Step 1: Write the failing tests**

Extend `tests/web/typeMirror.test.ts` with a union check for the delivery status, using the file's existing `SameUnion` helper:

```ts
it("mirrors the delivery status union", () => {
  type Check = SameUnion<
    NonNullable<BoardRow["deliveryStatus"]>,
    NonNullable<WebBoardRow["deliveryStatus"]>
  >;
  const ok: Check = true;
  expect(ok).toBe(true);
});
```

Add a board test asserting a dropped ledger row surfaces as `deliveryStatus: "dropped"` and that the row is **not** counted in the card's completion tally. Follow the existing board test harness.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test tests/web/typeMirror.test.ts`
Expected: FAIL — the web mirror is still the two-member union.

- [ ] **Step 3: Implement**

Invariants:
- Widen both sides of the mirror in the same commit. That is what the test is for.
- **The row reads as not-yet-sent, with an explanation.** A dropped row must offer 발송 again (nothing went out), must not be counted in `{n}/{total}곳 완료`, and must not be read-only the way a `sent` row is — `OutletCard.tsx:648` derives `sent` from `deliveryStatus === "sent"`, so a widened union that is not handled will make a dropped row behave like a sent one by accident.
- Korean copy for the state: say that the scheduled post was cancelled before it went out and can be sent again. Do not say 실패 — nothing failed; the draft was removed. Match the tone of the existing `예약됨` / `[게시 확인]` copy added in PR #85.
- The `at` timestamp on a dropped row is the moment it was *scheduled*, not the moment it was retired. Do not render it as if it were a send time.

- [ ] **Step 4: Verify in the browser**

Run: `pnpm build:web && pnpm serve`, then hand-edit `output/publish/deliveries.json` to set one row's `status` to `"dropped"`, reload `localhost:5757` and confirm the row reads correctly and 발송 is offered. **Restore the file afterwards.** `tsx` has no hot reload — restart `serve` after any `src/` change.

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web`

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/board.ts web/src/types.ts web/src/components/OutletCard.tsx tests/
git commit -m "feat(board): show a retired scheduled post as sendable, not sent"
```

---

### Task 4: `ReconcilePublished` retires a gone draft

**Files:**
- Modify: `src/app/ReconcilePublished.ts`
- Modify: `src/cli/send-reconcile.ts` (only if its wiring needs the new port shape)
- Test: `tests/app/reconcilePublished.test.ts`

**Read first:** `src/app/ReconcilePublished.ts` in full (86 lines) and `tests/app/reconcilePublished.test.ts`'s `ledgers()` harness — the tests below extend it rather than replacing it.

**Interfaces:**
- Consumes: `DraftState` (Task 1), `"dropped"` / `droppedAt` (Task 2).
- Produces: `ReconcilePublished.run()` returns `{ reconciled: number; retired: number; pending: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
it("retires a delivery row whose draft is gone", async () => {
  const { delivery, article, c } = ledgers([row({ postId: "10097383", url: undefined })], []);
  const lookup = { published: async () => ({ state: "gone" as const }) };
  const res = await new ReconcilePublished(delivery, article as any, lookup).run();
  expect(res).toEqual({ reconciled: 0, retired: 1, pending: 0 });
  expect(c[0]).toMatchObject({ itemId: "x:1", outletId: "x-post", status: "dropped" });
});

it("leaves a scheduled row alone", async () => {
  const { delivery, article, c } = ledgers([row({ postId: "10097383", url: undefined })], []);
  const lookup = { published: async () => ({ state: "scheduled" as const }) };
  const res = await new ReconcilePublished(delivery, article as any, lookup).run();
  expect(res).toEqual({ reconciled: 0, retired: 0, pending: 1 });
  expect(c[0]).toMatchObject({ status: "sent", url: undefined });
});

it("counts a thrown lookup as pending, never as gone", async () => {
  const { delivery, article, c } = ledgers([row({ postId: "10097383", url: undefined })], []);
  const lookup = { published: async () => { throw new Error("ECONNRESET"); } };
  const res = await new ReconcilePublished(delivery, article as any, lookup).run();
  expect(res).toEqual({ reconciled: 0, retired: 0, pending: 1 });
  expect(c[0].status).toBe("sent");
});

it("retires an article row whose draft is gone", async () => {
  const { delivery, article, a } = ledgers([], [{ itemId: "x:9", postId: "555", sentAt: "t" }]);
  const lookup = { published: async () => ({ state: "gone" as const }) };
  const res = await new ReconcilePublished(delivery, article as any, lookup).run();
  expect(res).toEqual({ reconciled: 0, retired: 1, pending: 0 });
  expect(a[0].droppedAt).toBeTruthy();
});

it("is idempotent — a retired row is not revisited", async () => {
  const { delivery, article } = ledgers([row({ postId: "1", status: "dropped" })], []);
  let calls = 0;
  const lookup = { published: async () => { calls += 1; return { state: "gone" as const }; } };
  expect(await new ReconcilePublished(delivery, article as any, lookup).run())
    .toEqual({ reconciled: 0, retired: 0, pending: 0 });
  expect(calls).toBe(0);
});
```

Update the existing published-row tests to return `{ state: "published", … }` and to expect the new `retired: 0` key.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test tests/app/reconcilePublished.test.ts`

- [ ] **Step 3: Implement**

Invariants:
- Switch on `state`. `published` behaves exactly as today. `gone` writes the row back with `status: "dropped"` (delivery) or `droppedAt` set to the injected clock (article) and increments `retired`. `scheduled` increments `pending`.
- **`postId` and `at` are preserved on a retired row.** They are the record of what was attempted; the live protocol in Task 7 needs the draft id to correlate.
- The `try/catch` around the lookup stays and still counts as `pending`. A thrown request is not evidence of anything.
- The article ledger needs a timestamp; `ReconcilePublished` has no clock today. Add an injected `now: () => string = () => new Date().toISOString()` as the **last** constructor argument, matching the convention in `SaveOutletOverride` and `SaveTranslation`.
- Update `src/cli/send-reconcile.ts`'s summary line to report retired rows in Korean alongside reconciled and pending. A silent retirement is the same class of bug as PR #85's `발송됨` that had not happened.

- [ ] **Step 4: Run and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: full suite PASS.

- [ ] **Step 5: Verify the tests can fail**

Make the `gone` branch fall through to `pending`, confirm the retire tests go red, restore.

- [ ] **Step 6: Commit**

```bash
git add src/app/ReconcilePublished.ts src/cli/send-reconcile.ts tests/app/reconcilePublished.test.ts
git commit -m "feat(send): retire a delivery row whose Typefully draft no longer exists"
```

---

### Task 5: Resend looks before it cancels

**Files:**
- Modify: `src/adapters/send/TypefullyDraftLookup.ts` (add `cancel`)
- Modify: `src/cli/sendToOutlet.ts:96-101`
- Modify: `src/cli/serve.ts` (inject the lookup into the resend path)
- Test: `tests/adapters/send/typefullyDraftLookup.test.ts`, `tests/cli/sendToOutlet.test.ts`

**Read first:** `src/cli/sendToOutlet.ts` in full, especially the four `if (previous) await deliveryLedger.add(previous)` restores. PR #89 exists because a new early-return was added between the `remove` and the restores and skipped one. This task adds more early returns to that same function — every one of them must restore, and the tests below are what prove it.

**Interfaces:**
- Consumes: `DraftLookup` (Task 1), `awaitingPublish` (Task 2).
- Produces: `TypefullyDraftLookup.cancel(draftId): Promise<boolean>` — `true` when the draft is gone after the call (204, or 404 meaning it was already gone), `false` when it could not be cancelled.

- [ ] **Step 1: Write the failing tests**

For the adapter:

```ts
it("cancels a draft", async () => {
  const { fn, calls } = fakeFetch({}, true, 204);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).cancel("100")).toBe(true);
  expect(calls[0].url).toContain("/v2/social-sets/42/drafts/100");
});

it("treats a 404 on cancel as already gone", async () => {
  const { fn } = fakeFetch({}, false, 404);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).cancel("100")).toBe(true);
});

it("reports a failed cancel", async () => {
  const { fn } = fakeFetch({}, false, 500);
  expect(await new TypefullyDraftLookup("KEY", "42", fn).cancel("100")).toBe(false);
});
```

Note: `fakeFetch` does not currently record the HTTP method. Extend it to capture `init?.method` and assert `DELETE`.

For `sendToOutlet` — follow the existing harness in `tests/cli/sendToOutlet.test.ts`:

```ts
it("refuses a resend when the original has already published, and reconciles the row", async () => {
  // ledger holds a sent x-post row with postId = a Typefully draft id and no url
  // lookup.published → { state: "published", xUrl: "https://x.com/a/status/777", xId: "777" }
  // expect: sent === 0, an error mentioning the original is already live,
  //         the ledger row now carries url "https://x.com/a/status/777" and postId "777",
  //         and the sender was NEVER called.
});

it("cancels a still-scheduled original before resending", async () => {
  // lookup.published → { state: "scheduled" }; lookup.cancel → true
  // expect: cancel called with the original draft id, sent === 1
});

it("refuses the resend when cancelling fails", async () => {
  // lookup.published → { state: "scheduled" }; lookup.cancel → false
  // expect: sent === 0, the sender was NEVER called, and the previous ledger row is restored
});

it("resends without cancelling when the original draft is gone", async () => {
  // lookup.published → { state: "gone" }
  // expect: cancel NOT called, sent === 1
});

it("does not consult Typefully when resending a telegram row", async () => {
  // a tg-community row: awaitingPublish is false, so published/cancel must not be called at all
});
```

The two refusal tests must assert **the sender was never called**. An assertion on the returned error message alone would pass while the post went out.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test tests/cli/sendToOutlet.test.ts tests/adapters/send/typefullyDraftLookup.test.ts`

- [ ] **Step 3: Implement**

Invariants:
- The check runs **only** when `previous` exists and `awaitingPublish(previous)` is true. Telegram rows and already-reconciled X rows must not cost a Typefully round-trip.
- The check runs **before** `deliveryLedger.remove(key)`. On the `published` refusal the row is updated in place, not removed and restored.
- Three outcomes, per the spec's table: `published` → refuse and write the real url/id into the row; `gone` → proceed; `scheduled` → `cancel`, proceed on `true`, **refuse on `false`**.
- **Every new early return leaves the ledger exactly as it found it.** The `published` branch returns before the `remove`; the cancel-failure branch either returns before the `remove` or restores `previous`. Prefer returning before the `remove` — a restore that has to be remembered is the bug PR #89 was written about.
- A thrown lookup on the resend path must **refuse**, not proceed. Unlike the reconcile — which can afford to wait — proceeding here risks a double post.
- Error strings are Korean and follow the existing `${outlet.label} (${outlet.id}): …` shape used by the neighbouring refusals.
- `serve.ts` composes the lookup from `loadTypefullyConfig()` in its own `try/catch`, the way `makeHeadroomReader` is composed. If Typefully is unconfigured, resend behaves as it does today for non-X rooms; it must not throw at construction and take the whole dashboard down.

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`

- [ ] **Step 5: Verify the tests can fail**

Delete the cancel-failure refusal so the code proceeds, and confirm the "refuses the resend when cancelling fails" test goes red on the *sender was never called* assertion specifically. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/send/TypefullyDraftLookup.ts src/cli/sendToOutlet.ts src/cli/serve.ts tests/
git commit -m "feat(send): cancel a queued draft before resending instead of double-posting"
```

---

### Task 6: A cross-process file lock on the send ledgers

**Files:**
- Create: `src/shared/store/fileLock.ts`
- Create: `tests/shared/store/fileLock.test.ts`, `tests/shared/store/fileLock.child.mjs`
- Modify: `src/adapters/store/JsonDeliveryLedger.ts`, `src/adapters/store/JsonXArticleLedger.ts`
- Modify: `src/cli/clean.ts`, `src/storage/retention.ts`

**Read first:** `src/shared/store/serialWrites.ts` — its doc comment states the exact gap this task closes, and says honestly that two instances do not protect each other. Update that comment rather than leaving it describing a limitation that no longer holds at the ledger level.

**Interfaces:**
- Consumes: nothing.
- Produces: `withFileLock<T>(path: string, fn: () => Promise<T>, opts?: { staleMs?: number; timeoutMs?: number }): Promise<T>`.

- [ ] **Step 1: Write the failing tests**

`tests/shared/store/fileLock.child.mjs` — a real child process that appends through the lock:

```js
import { withFileLock } from "../../../src/shared/store/fileLock.ts";
import { readFile, writeFile } from "node:fs/promises";

const [, , path, value] = process.argv;
await withFileLock(path, async () => {
  const current = JSON.parse(await readFile(path, "utf8").catch(() => "[]"));
  // Widen the race window so an unlocked implementation reliably loses a row.
  await new Promise((r) => setTimeout(r, 50));
  await writeFile(path, JSON.stringify([...current, value]));
});
```

`tests/shared/store/fileLock.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { withFileLock } from "../../../src/shared/store/fileLock";

const run = (script: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = fork(script, args, { execArgv: ["--import", "tsx"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });

describe("withFileLock", () => {
  it("keeps both rows when two processes append concurrently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const path = join(dir, "ledger.json");
    await writeFile(path, "[]");
    const script = join(import.meta.dirname, "fileLock.child.mjs");
    await Promise.all([run(script, [path, "a"]), run(script, [path, "b"])]);
    expect(JSON.parse(await readFile(path, "utf8")).sort()).toEqual(["a", "b"]);
  });

  it("releases the lock when the job throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const path = join(dir, "ledger.json");
    await expect(withFileLock(path, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // A second acquisition proves the lock file is gone.
    expect(await withFileLock(path, async () => "ok")).toBe("ok");
  });

  it("reclaims a stale lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    // Backdate it well past the staleness threshold.
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(`${path}.lock`, old, old);
    expect(await withFileLock(path, async () => "ok", { staleMs: 1_000 })).toBe("ok");
  });

  it("gives up rather than proceeding unprotected when the lock is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    const path = join(dir, "ledger.json");
    await writeFile(`${path}.lock`, "");
    await expect(
      withFileLock(path, async () => "never", { staleMs: 60_000, timeoutMs: 200 }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm test tests/shared/store/fileLock.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Invariants:
- Acquire with `open(lockPath, "wx")` — `O_CREAT | O_EXCL`, atomic. On `EEXIST`, sleep a short interval and retry until `timeoutMs`.
- Before retrying, check the lock's mtime: older than `staleMs` means the holder died, so remove it and try again. Removing a lock is itself racy — tolerate `ENOENT` on the unlink.
- On timeout, **throw**. Proceeding unprotected converts a delay into a lost row, and a lost row is a duplicate live post.
- Release in `finally`, tolerating `ENOENT`.
- Write the owning pid into the lock file. It costs nothing and turns "why is this stuck" into a one-line answer.
- Defaults: pick a `staleMs` comfortably longer than the slowest ledger write and a `timeoutMs` longer than that again. State the numbers and the reasoning in a doc comment rather than leaving bare literals.
- **Wrap, do not replace, `serial(...)`.** In both ledgers the shape becomes `this.serial(() => withFileLock(this.path, async () => { …existing body… }))`. In-process ordering keeps its cheap queue; cross-process contention hits the lock.
- `JsonXArticleLedger` locks its own path. Two files, two locks — never one shared lock, which would serialize unrelated writes.
- `isStrandedTempFile` in `src/storage/retention.ts` learns to match `*.lock` so `pnpm clean` sweeps abandoned ones. Add a test there; it is a pure function.

- [ ] **Step 4: Run everything**

Run: `pnpm test && pnpm typecheck`

- [ ] **Step 5: Verify the concurrency test can fail**

Change `withFileLock` to call `fn()` directly with no locking. The concurrent-append test must go red (one row lost). Restore. **This is the single most important mutation check in this plan** — a concurrency test that passes without the lock is testing nothing.

- [ ] **Step 6: Commit**

```bash
git add src/shared/store/fileLock.ts src/shared/store/serialWrites.ts src/adapters/store/ src/cli/clean.ts src/storage/retention.ts tests/
git commit -m "feat(store): serialize send-ledger writes across processes with a file lock"
```

---

### Task 7: Live verification, then documentation

**Files:**
- Modify: `CHANGELOG.md`, `docs/ko/team-runbook.md`
- Touch (temporarily): `output/formatted/renderings.json`, `output/publish/deliveries.json`

**Read first:** the spec's *Live verification* section. Read `docs/ko/team-runbook.md`'s existing send section for the voice the new copy has to match.

**This is the only task that sends. Tasks 1–6 must all be committed and green first.**

- [ ] **Step 1: Snapshot the real state**

Copy `output/formatted/renderings.json`, `output/publish/deliveries.json` and `output/publish/x-article.json` into `output/archive/qa-<stamp>/`. Record `pnpm doctor --live`'s quota line. Confirm the five real items are untouched at the end by diffing against this snapshot.

- [ ] **Step 2: Inject the synthetic item**

Add one approved `x`-channel rendering for `x:qa-<stamp>` to `output/formatted/renderings.json`, with **two posts separated by a blank-line boundary** so it is a genuine thread, and short filler text. Do not create a translation, a variant, or a few-shot entry — nothing else in the pipeline should know this item exists.

- [ ] **Step 3: Thread billing**

Read the quota. Send: `pnpm send:channels --target x --ids qa-<stamp>` (needs `dangerouslyDisableSandbox` for network). Read the quota **immediately after scheduling**. Wait for publication, run `pnpm send:reconcile`, read the quota again.

Record: the delta at scheduling, the delta after publication, and whether the total delta is 1 (per draft) or 2 (per tweet). **If it is per-tweet, `SendChannels`'s `needed` arithmetic is wrong and that is a new finding to write up — do not fix it inside this task.**

- [ ] **Step 4: The stuck row, and the `gone` response**

Send the synthetic item to the room again (resend). Within the two-minute window, **delete the draft in Typefully's UI**. Then:

1. `pnpm doctor --live` — confirm `available` has dropped by one against a raw `remaining` that did not move. That is the gap, reproduced.
2. Capture the raw HTTP response for the deleted draft (a direct `curl` to `/v2/social-sets/283589/drafts/<id>` with the API key). **Confirm it is a 404.** If it is not, Task 1's mapping is wrong and must be corrected before this branch merges.
3. `pnpm send:reconcile` — confirm it reports one retired row, the ledger row reads `dropped`, and `available` recovers.
4. Reload the dashboard and confirm the row reads as sendable with the retired explanation.

- [ ] **Step 5: Resend cancels the original**

Send once more. Within the window, press 재발송 on the board. Confirm: exactly **one** post appears on @bcd_kyle, the ledger holds one row, and note whether the cancelled draft refunded its publish.

- [ ] **Step 6: Clean up**

Remove the synthetic rendering and every `x:qa-<stamp>` ledger row. Diff the three files against the Step 1 snapshot and confirm the real items are byte-identical. The test posts stay live on @bcd_kyle — a send is final.

- [ ] **Step 7: Write it down**

`CHANGELOG.md` under `[Unreleased]`: the three fixes in Korean, plus an **upgrade note** — an operator may see a row change from 발송됨 to the retired state the first time `send:reconcile` runs after upgrading, and that is the fix working, not data loss.

`docs/ko/team-runbook.md`: what the retired state means, that the room can be sent to again, and that `pnpm send:reconcile` is what produces it. **Delete the hand-editing instruction for stuck rows** if the runbook carries one — leaving it beside the automatic path is exactly the documentation drift this repo keeps rediscovering.

Record the measured billing unit in the memory file, replacing the "unverified assumption" note.

- [ ] **Step 8: Commit and open the PR**

```bash
git add CHANGELOG.md docs/ko/team-runbook.md
git commit -m "docs: record the retired-send state and the measured Typefully billing unit"
git push -u origin fix/typefully-hardening
gh pr create --title "fix(send): retire dead drafts, cancel before resending, lock the ledgers" --body "…"
```

CI (`test`) must go green before the squash merge — a merge attempted immediately after the push is rejected.

---

## Self-Review

**Spec coverage.** §1 three-way `published()` → Task 1. §2 `dropped` status and the already-received invariant → Tasks 2 and 3. §3 resend look-before-cancel → Task 5. §4 file lock → Task 6. The reconcile's third branch → Task 4. Live verification steps 1–4 → Task 7 steps 3–5, with the file-lock row (step 4 of the spec's table) covered by Task 6's child-process test instead. The spec's open question about a publish-time failure state is answered by Task 7 step 4's captured response.

**Type consistency.** `DraftState` is produced in Task 1 and consumed in Tasks 4 and 5 under that name. `DraftLookup` declares `published` and `cancel` in Task 1; the adapter implements `cancel` in Task 5, which is why Task 1's implementation notes say not to add `implements DraftLookup` yet. `"dropped"` (delivery) and `droppedAt` (article) are introduced in Task 2 and used in Tasks 3 and 4. `run()`'s return gains `retired` in Task 4 and nothing earlier depends on it.

**Known ordering constraint.** Tasks 1 and 2 each leave the tree typechecking only in the files they own; the full `pnpm typecheck` is clean from Task 4 onward. Each task's Step 4 says which failures are expected, so a reviewer does not read a planned intermediate state as a defect.
