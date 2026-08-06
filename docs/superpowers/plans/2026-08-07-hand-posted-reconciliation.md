# Hand-posted reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `x:reconcile` recognise a translation that was published by hand — rewritten, not pasted — and retire it to a new terminal `posted` status so it leaves 1차 검수 and can never be sent again.

**Architecture:** A second pass inside `reconcileXPublished` walks *translations* (the existing pass walks threads), scores each against its single best live thread with the existing `similarity()`, and at or above `TRANSLATION_MATCH_AT = 0.25` produces a retire. The retire writes the translation's status plus two new columns, then a publish-history row. Nothing on this path writes a delivery row, so there is no `deliveryKey` and no `type` to choose.

**Tech Stack:** TypeScript ESM, hexagonal (domain / ports / adapters / app / cli), `zod` the only runtime dependency, vitest, Postgres via `src/adapters/db`, React + Vite + Tailwind v4 for `web/`.

**Spec:** `docs/superpowers/specs/2026-08-07-hand-posted-reconciliation-design.md` — read it first. Its measurement table is the justification for every constant here.

## Global Constraints

- **Runtime dependencies stay `zod`-only.** No new runtime package, for any task. Test-only devDeps are fine.
- **Code, comments, and commit messages in English.** Korean only in user-facing UI strings and `docs/ko/`.
- **The new status string is `posted`; its Korean board label is `게시됨`.** Never `published` — that word already means "uploaded to Drive" in this repo.
- **`TRANSLATION_MATCH_AT = 0.25`.** Do not move it without re-running the fixture test.
- **Every test must be able to fail.** Before accepting any test, confirm it fails against the unmodified code. A test whose assertion the current code already satisfies is a plan failure, not a passing task.
- **`similarity()`, `CONFIRMED_AT`, `CANDIDATE_AT`, `isXCandidateRendering` and the whole rendering→delivery path are untouched.** If a change to them looks necessary, stop and report rather than editing.
- Run `pnpm test` and `pnpm typecheck` (both projects) before every commit.

---

### Task 1: The labelled fixture and the domain match

**Files:**
- Create: `tests/fixtures/handPostedPairs.json` — already generated and present in the worktree; commit it as-is, do not regenerate (it needs production and a live API key).
- Modify: `src/domain/publish/xReconcile.ts`
- Test: `tests/domain/xReconcileTranslationMatch.test.ts`

**Interfaces:**
- Consumes: `similarity` from `src/domain/kol/attribution`, `threadText` and `AssembledThread` from the existing module.
- Produces:
  - `export const TRANSLATION_MATCH_AT = 0.25`
  - `export function bestThreadFor(koreanText: string, threads: AssembledThread[]): { thread: AssembledThread; score: number } | undefined` — the single highest-scoring thread, `undefined` when `threads` is empty. Ties break on first-in-input-order, matching `classify`'s existing convention.

- [ ] **Step 1: Read the spec's measurement section and the fixture**

Read `docs/superpowers/specs/2026-08-07-hand-posted-reconciliation-design.md` §"The measurement", then `tests/fixtures/handPostedPairs.json`. Each row is one translation, its top-1 live thread, the measured score, and a `samePost` label assigned by reading both texts. Five rows are `true`, four are `false`.

- [ ] **Step 2: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRANSLATION_MATCH_AT, bestThreadFor } from "../../src/domain/publish/xReconcile";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

interface Pair {
  itemId: string;
  koreanText: string;
  topRootId: string;
  topLiveText: string;
  topPostedAt: string;
  measuredScore: number;
  runnerUpScore: number;
  samePost: boolean;
}
const { pairs } = JSON.parse(readFileSync("tests/fixtures/handPostedPairs.json", "utf8")) as { pairs: Pair[] };

/** One live thread carrying the fixture's captured text, so scores are reproducible offline. */
const threadOf = (rootId: string, text: string): AssembledThread => ({
  rootId,
  tweets: [
    {
      id: rootId,
      conversationId: rootId,
      text,
      createdAt: "2026-07-31T05:39:41.000Z",
      url: `https://x.com/0xMantleKR/status/${rootId}`,
      authorUserName: "0xMantleKR",
      isReply: false,
      isQuote: false,
    } satisfies SourceTweet,
  ],
});

describe("translation match against a hand-posted rewrite", () => {
  it("has five positives and four negatives in the fixture", () => {
    expect(pairs.filter((p) => p.samePost)).toHaveLength(5);
    expect(pairs.filter((p) => !p.samePost)).toHaveLength(4);
  });

  it("admits every labelled positive and rejects every labelled negative", () => {
    for (const p of pairs) {
      const best = bestThreadFor(p.koreanText, [threadOf(p.topRootId, p.topLiveText)]);
      expect(best, p.itemId).toBeDefined();
      expect(best!.score, `${p.itemId} score drifted from the 2026-08-07 measurement`).toBeCloseTo(p.measuredScore, 3);
      expect(best!.score >= TRANSLATION_MATCH_AT, `${p.itemId} (samePost=${p.samePost})`).toBe(p.samePost);
    }
  });

  // Pins the threshold from BOTH sides. Asserting only that 0.484 passes would still pass at a
  // threshold of 0.40, which is a test that cannot fail.
  it("sits between the lowest positive and the highest negative", () => {
    const minPositive = Math.min(...pairs.filter((p) => p.samePost).map((p) => p.measuredScore));
    const maxNegative = Math.max(...pairs.filter((p) => !p.samePost).map((p) => p.measuredScore));
    expect(minPositive).toBeCloseTo(0.3077, 3);
    expect(maxNegative).toBeCloseTo(0.0917, 3);
    expect(TRANSLATION_MATCH_AT).toBeGreaterThan(maxNegative);
    expect(TRANSLATION_MATCH_AT).toBeLessThan(minPositive);
  });

  it("picks the highest-scoring thread, not the first", () => {
    const target = pairs.find((p) => p.samePost)!;
    const decoy = pairs.find((p) => !p.samePost)!;
    const best = bestThreadFor(target.koreanText, [
      threadOf(decoy.topRootId, decoy.topLiveText),
      threadOf(target.topRootId, target.topLiveText),
    ]);
    expect(best!.thread.rootId).toBe(target.topRootId);
  });

  it("returns undefined when there are no threads", () => {
    expect(bestThreadFor("아무 텍스트", [])).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails for the right reason**

Run: `pnpm vitest run tests/domain/xReconcileTranslationMatch.test.ts`
Expected: FAIL — `TRANSLATION_MATCH_AT` and `bestThreadFor` are not exported yet. A failure for any *other* reason (a missing fixture, a JSON parse error) means fix that first; do not proceed on a red test you have not explained.

- [ ] **Step 4: Implement**

In `src/domain/publish/xReconcile.ts`, beside the existing `CONFIRMED_AT`/`CANDIDATE_AT`:

Invariants, not a snippet — decide placement yourself after reading the module:
- `TRANSLATION_MATCH_AT` carries a comment explaining the **asymmetry** that put it off-centre: a missed match leaves the item in 검수 대기 exactly as today, while a false match silently retires something a human still needed. Cite the measured 0.3077 / 0.0917.
- `bestThreadFor` scores with `similarity(threadText(thread), koreanText)` — argument order matters only for readability here, but keep it consistent with `classify`'s `similarity(text, candidate.text)`.
- It is pure: no clock, no I/O, no `process.env`, in keeping with the module's header comment.
- It must not call `classify` or `bestMatch`; both band or floor the score, and this needs the raw number.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `pnpm vitest run tests/domain/xReconcileTranslationMatch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Mutation-check the threshold test**

Temporarily set `TRANSLATION_MATCH_AT = 0.05`, re-run. The "admits every positive and rejects every negative" test and the both-sides test must BOTH fail. Then set it to `0.5`; both must fail again. Restore `0.25`. If either mutation leaves the suite green, the test is not pinning what it claims and must be fixed before committing.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/handPostedPairs.json tests/domain/xReconcileTranslationMatch.test.ts src/domain/publish/xReconcile.ts
git commit -m "feat(reconcile): score a translation against the live thread that best matches it"
```

---

### Task 2: The `posted` status and the two columns

**Files:**
- Modify: `src/domain/translation/models.ts`, `src/adapters/db/schema.ts`, `src/adapters/store/PgTranslationStore.ts`, `src/app/SaveTranslation.ts`
- Test: `tests/domain/translationStatus.test.ts`, and extend the existing `PgTranslationStore` / `SaveTranslation` tests (find them under `tests/` — do not create parallel duplicates)

**Interfaces:**
- Produces:
  - `export const ALL_TRANSLATION_STATUSES = ["translated", "approved", "posted"] as const`
  - `export type TranslationStatus = (typeof ALL_TRANSLATION_STATUSES)[number]`
  - `Translation` gains `postedUrl?: string` and `postedAt?: string`
- Consumed by every later task.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { ALL_TRANSLATION_STATUSES } from "../../src/domain/translation/models";

describe("translation statuses", () => {
  // The array is the runtime source of truth. A `satisfies`-checked literal erases under esbuild —
  // see the same argument on ALL_DELIVERY_STATUSES in src/domain/delivery/models.ts.
  it("carries all three statuses at runtime", () => {
    expect([...ALL_TRANSLATION_STATUSES]).toEqual(["translated", "approved", "posted"]);
  });
});
```

And in `tests/app/saveTranslation.test.ts`, the invariant that matters most. Note its existing
`stores()` helper's `upsert` **appends** (`saved.push(t)`) rather than replacing by itemId, which is
fine for the tests already there but hides this one — so this test needs a replacing store:

```ts
/** Like `stores()` above, but `upsert` replaces by itemId the way a real store does. */
function replacingStores(seed: Translation[] = []) {
  const saved = [...seed];
  const fewShots: FewShotExample[] = [];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => {
      const i = saved.findIndex((x) => x.itemId === t.itemId);
      if (i >= 0) saved[i] = t;
      else saved.push(t);
    },
    listTranslatedIds: async () => new Set(saved.map((t) => t.itemId)),
  };
  const fewShotStore: FewShotStore = { load: async () => fewShots, add: async (ex) => { fewShots.push(ex); } };
  return { saved, fewShots, translationStore, fewShotStore };
}

it("does not clear postedUrl or postedAt when an edit is saved", async () => {
  // `run` builds a whole new Translation and upserts it, so without care the retire evidence is
  // silently dropped — and losing postedUrl means the next reconcile re-retires an item a human
  // deliberately reverted.
  const retired: Translation = {
    itemId: "x:1",
    source: "x",
    sourceText: "hi",
    koreanText: "안녕",
    status: "posted",
    translatedAt: "2026-05-05T00:00:00.000Z",
    postedUrl: "https://x.com/0xMantleKR/status/999",
    postedAt: "2026-07-31T05:39:41.000Z",
  };
  const s = replacingStores([retired]);
  const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-06T00:00:00.000Z");

  await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕하세요", approve: false });

  expect(s.saved).toHaveLength(1);
  expect(s.saved[0].koreanText).toBe("안녕하세요");
  expect(s.saved[0].status).toBe("translated"); // the revert path: off `posted`…
  expect(s.saved[0].postedUrl).toBe("https://x.com/0xMantleKR/status/999"); // …but the evidence stays
  expect(s.saved[0].postedAt).toBe("2026-07-31T05:39:41.000Z");
});
```

And the safety property the spec leans on — that retiring is what stops re-sending — asserted rather
than assumed. `PrepareConversions` filters `status === "approved"` (`src/app/PrepareConversions.ts:37`),
so a `posted` item is already excluded; this pins it so a future widening of that filter fails here:

```ts
// in tests/app/ — alongside the existing PrepareConversions tests, not in a new file
it("never offers a posted translation for conversion", async () => {
  // Seed one approved and one posted translation; only the approved itemId may come back.
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run tests/domain/translationStatus.test.ts <the SaveTranslation test file>`
Expected: FAIL — `ALL_TRANSLATION_STATUSES` is not exported; the preservation test fails because `SaveTranslation.run` constructs a fresh `Translation`.

- [ ] **Step 3: Implement**

Invariants:
- `src/domain/translation/models.ts`: derive the type from the array. Copy the *reasoning* (not the prose) from `ALL_DELIVERY_STATUSES`' comment — one repo, one explanation of why derivation beats declaration.
- `src/adapters/db/schema.ts`: two `alter table translations add column if not exists …` statements, following exactly the shape and the comment style already used for `auth_attempts.last_attempt_at`. `create table if not exists` for `translations` stays unchanged so existing databases migrate on the next `applySchema`.
- `src/adapters/store/PgTranslationStore.ts`: read and write both columns. `upsert` must round-trip them.
- `src/app/SaveTranslation.ts`: **a save must never clear `postedUrl`/`postedAt`.** `run` builds a whole new `Translation` and upserts it, so today it would drop them. How to fix is yours — reading the existing row, or narrowing what `upsert` writes — but the chosen approach must not add a second write path that a later retire could race with. Note that `status` is still `approve ? "approved" : "translated"`; a save on a retired item is the 되돌리기 path in Task 5 and is *supposed* to move it off `posted`.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS. Existing translation tests must still pass — if one breaks, understand it before changing it; a test that asserted a two-status world may be pinning something real.

- [ ] **Step 5: Mutation-check**

Delete the `postedUrl` line from whatever preserves it in `SaveTranslation`; the preservation test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/domain/translation/models.ts src/adapters/db/schema.ts src/adapters/store/PgTranslationStore.ts src/app/SaveTranslation.ts tests/
git commit -m "feat(translation): add the posted status and the two columns that evidence it"
```

---

### Task 3: The second pass in `reconcileXPublished`

**Files:**
- Modify: `src/app/ReconcileXPublished.ts`
- Test: extend `tests/app/reconcileXPublished.test.ts` (locate the existing file; add to it rather than starting a new one)

**Interfaces:**
- Consumes: `bestThreadFor`, `TRANSLATION_MATCH_AT` (Task 1); `Translation` with `postedUrl` (Task 2).
- Produces: `reconcileXPublished` gains a `translations: Translation[]` input and `ReconcilePlan` gains
  `posted: { itemId: string; rootId: string; score: number; url: string; postedAt: string }[]`.

- [ ] **Step 1: Write the failing tests**

`tests/app/reconcileXPublished.test.ts` already has `thread(rootId, texts)`, `rendering(itemId, text, over)`,
`base`, and the shared `COPY` constant. Reuse them; add one translation helper:

```ts
function translation(itemId: string, koreanText: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId,
    source: "x",
    sourceText: "en",
    koreanText,
    status: "translated",
    translatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// A rewrite of COPY: the same post, edited the way a human edits it before posting. Scores well
// above TRANSLATION_MATCH_AT and nowhere near CONFIRMED_AT — which is the whole point.
const COPY_REWRITTEN =
  "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

describe("translations that already went out by hand", () => {
  it("retires a translation whose best live thread clears the threshold", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY_REWRITTEN])],
      renderings: [],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0]).toMatchObject({
      itemId: "x:1",
      rootId: "100",
      url: "https://x.com/0xMantleKR/status/100",
      postedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(plan.posted[0].score).toBeGreaterThanOrEqual(TRANSLATION_MATCH_AT);
  });

  it("leaves a translation below the threshold alone and writes nothing for it", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", ["전혀 관계없는 다른 주제의 게시물입니다. 오늘 날씨가 좋네요."])],
      renderings: [],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.posted).toEqual([]);
  });

  it("never matches a translation that already has postedUrl", () => {
    // Even on an exact match. This is what makes 되돌리기 stick: a human who reverts a wrong retire
    // keeps postedUrl, and the next tick must not undo their undo.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [],
      translations: [translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/100" })],
    });
    expect(plan.posted).toEqual([]);
  });

  it("skips a translation whose item the rendering route confirmed in this run", () => {
    // The delivery row is the stronger record — it carries a real type and passed 2차 검수.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:1", COPY)],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.posted).toEqual([]);
  });

  it("never reuses a thread already consumed by a confirmed rendering match", () => {
    // One live post must never become both a delivery row (for x:1) and a retire (for x:2).
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      translations: [translation("x:2", COPY)],
    });
    expect(plan.confirmed).toHaveLength(1);
    expect(plan.posted).toEqual([]);
  });

  it("gives one thread to only one translation", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY_REWRITTEN])],
      renderings: [],
      translations: [translation("x:1", COPY), translation("x:2", COPY)],
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.posted[0].itemId).toBe("x:1"); // first in input order wins, as claimedItemIds already does
  });

  it("ignores a rootless thread, which has no url or timestamp to stamp", () => {
    const rootless: AssembledThread = { rootId: "999", tweets: thread("100", [COPY]).tweets };
    const plan = reconcileXPublished({ ...base, threads: [rootless], renderings: [], translations: [translation("x:1", COPY)] });
    expect(plan.posted).toEqual([]);
  });
});
```

Then confirm the existing suite still holds with the new required input — every current call site in
this file needs `translations: []` added, and none of their assertions may change.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run tests/app/reconcileXPublished.test.ts`
Expected: FAIL — `translations` is not an accepted input and `plan.posted` does not exist. Confirm each new test fails for that reason and not because a helper is missing.

- [ ] **Step 3: Implement**

Read the whole of `src/app/ReconcileXPublished.ts` first — the existing loop's guards (rootless threads, `deliveredKeys`, `claimedItemIds`, `historyPostIds`) are the vocabulary this pass has to fit into.

Invariants:
- The new pass runs **after** the existing thread loop, over `translations`, and reuses the same `threads` array. Do not fold it into the existing loop; the two ask different questions in different directions and merging them is how the `everDelivered` class of bug happens (see the `isXCandidateRendering` doc comment for what a second spelling of one predicate cost this repo).
- Skip a translation when: `postedUrl` is set; **or** its `itemId` is in the set of itemIds confirmed by the rendering route this run; **or** its `koreanText` is empty.
- Exclude from its candidate threads every thread already consumed by a `plan.confirmed` row, so one live post can never produce both a delivery row and a retire.
- A rootless thread (`findRootTweet` undefined) must not be a candidate here either — the retire stamps `url`/`postedAt` from the root, exactly like `observedDelivery`/`externalHistoryRecord`, and the module's existing comment explains why falling back to `tweets[0]` is worse than skipping.
- Stays pure. Timestamps come from the thread.
- One retire per translation and one per thread: two translations must not both claim the same live thread. First in input order wins, matching `claimedItemIds`' existing convention.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Mutation-check the skip rules**

Remove the `postedUrl` skip → the "never matches a translation that already has postedUrl" test must fail. Remove the consumed-thread exclusion → the "never reuses a thread" test must fail. Restore both.

- [ ] **Step 6: Commit**

```bash
git add src/app/ReconcileXPublished.ts tests/app/reconcileXPublished.test.ts
git commit -m "feat(reconcile): ask each translation whether it already went out"
```

---

### Task 4: Retiring for real — use-case, history row, CLI, alert

**Files:**
- Create: `src/app/RetireTranslation.ts`, `src/shared/notifyOps.ts`
- Modify: `src/cli/x-reconcile.ts`, `src/cli/xReconcileReport.ts`
- Test: `tests/app/retireTranslation.test.ts`, `tests/shared/notifyOps.test.ts`, and extend the `xReconcileReport` tests

**Interfaces:**
- Consumes: `plan.posted` (Task 3), `TranslationStore` (Task 2), `RecordPublish` from `src/app/RecordPublish.ts`, `SheetClient`.
- Produces:
  - `class RetireTranslation`, constructed
    `(translationStore: TranslationStore, publisher: RecordPublish, historyIds: Set<string>, historyPostIds: Set<string>)`
    — the two sets are the `history` tab read the two ways `x-reconcile.ts`'s `loadHistoryKeys` already
    returns, passed in rather than re-read so the CLI keeps one read per run.
  - `run(input: { itemId: string; rootId: string; url: string; postedAt: string }): Promise<"retired" | "already-retired">`
    — `rootId` is required and is what lands in the history row's `postId`; omitting it was a bug in
    an earlier draft of this plan, caught because the history row could not have been built without it.
  - `export async function notifyOps(text: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/app/retireTranslation.test.ts
import { describe, expect, it, vi } from "vitest";
import { RetireTranslation } from "../../src/app/RetireTranslation";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";

const RETIRE = { itemId: "x:1", rootId: "100", url: "https://x.com/0xMantleKR/status/100", postedAt: "2026-07-31T05:39:41.000Z" };

function fixture(over: Partial<Translation> = {}) {
  const calls: string[] = [];
  const saved: Translation[] = [
    { itemId: "x:1", source: "x", sourceText: "en", koreanText: "안녕", status: "translated", translatedAt: "2026-08-01T00:00:00.000Z", ...over },
  ];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => {
      calls.push("status");
      saved[saved.findIndex((x) => x.itemId === t.itemId)] = t;
    },
    listTranslatedIds: async () => new Set(saved.map((t) => t.itemId)),
  };
  const recorded: unknown[] = [];
  const publisher = { record: vi.fn(async (r: unknown) => { calls.push("history"); recorded.push(r); }) };
  return { calls, saved, recorded, publisher, translationStore };
}

describe("RetireTranslation", () => {
  it("sets status to posted and stamps postedUrl and postedAt", async () => {
    const f = fixture();
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("retired");
    expect(f.saved[0]).toMatchObject({ status: "posted", postedUrl: RETIRE.url, postedAt: RETIRE.postedAt });
  });

  it("returns already-retired and writes no status when postedUrl is already set", async () => {
    const f = fixture({ postedUrl: RETIRE.url, status: "posted" });
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("already-retired");
    expect(f.calls).not.toContain("status");
  });

  it("writes the status BEFORE the history row", async () => {
    // Load-bearing. A history row written first makes the next reconcile skip the item via
    // historyPostIds, leaving it permanently unretireable if the status write then fails.
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(f.calls).toEqual(["status", "history"]);
  });

  it("still reports the retire when the history write throws, so the next run retries the row", async () => {
    const f = fixture();
    f.publisher.record.mockRejectedValueOnce(new Error("HTTP 500"));
    const res = await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(res).toBe("retired");
    expect(f.saved[0].status).toBe("posted");
  });

  it("keys the history row x:<itemId>, not kr:<rootId>", async () => {
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set()).run(RETIRE);
    expect(f.recorded[0]).toMatchObject({
      itemId: "x:1",
      type: "x",
      channel: "x",
      outletId: "x-post",
      postId: "100",
      status: "posted",
      publishedAt: RETIRE.postedAt,
    });
  });

  it("skips the history row when the postId is already recorded under another itemId", async () => {
    const f = fixture();
    await new RetireTranslation(f.translationStore, f.publisher as never, new Set(), new Set(["100"])).run(RETIRE);
    expect(f.publisher.record).not.toHaveBeenCalled();
    expect(f.saved[0].status).toBe("posted"); // the retire still happens
  });
});
```

```ts
// tests/shared/notifyOps.test.ts — inject fetch rather than stubbing the global, matching how
// TelegramBotSender is tested in this repo (read that test first and follow its shape).
it("posts to the bot API when both env vars are set", async () => {});
it("does nothing and does not throw when either env var is missing", async () => {});
it("swallows a failing request", async () => {}); // an alert must never fail the run that raised it
```

The three `notifyOps` bodies are intentionally left for you to write against the existing Telegram
test's fixtures — I have not read that file, so any fetch-fake I wrote here would likely name the
wrong shape. Write them, then confirm each fails before implementing.

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm vitest run tests/app/retireTranslation.test.ts tests/shared/notifyOps.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Implement**

Read `src/app/RecordObservedDelivery.ts` first: it is the closest existing shape (an observation recorded idempotently, returning a discriminated outcome rather than a boolean) and `RetireTranslation` should read as its sibling.

Invariants:
- **Status write first, history row second.** Both idempotent, and *independently* so: a translation already carrying `postedUrl` is `already-retired`; a history row already present (by `x:<itemId>` in `historyIds` or the rootId in `historyPostIds`) is skipped on its own. A history failure is reported and swallowed — the retire stands and the next run retries the row.
- The `PublishRecord` is `{ itemId: "x:<itemId>", type: "x", channel: "x", outletId: "x-post", postId: <rootId>, url, status: "posted", publishedAt: <the live post's createdAt> }`.
- `notifyOps` mirrors `deploy/herald-notify-failure.sh`'s env contract exactly — `TELEGRAM_BOT_TOKEN` **and** `TELEGRAM_CHAT_ID_OPS`, silent no-op when either is absent — because an operator who has configured one alert path expects the other to use the same switch. Read that script before writing it. Uses global `fetch`; no new dependency.

Then wire `src/cli/x-reconcile.ts`:
- Load translations alongside the existing `Promise.all`, pass them into `reconcileXPublished`.
- Print a `posted (N)` section in the same shape as the existing `confirmed`/`external` sections — one line per row with itemId, score, and the live URL — and print sub-threshold near-misses the same way the existing `nearMisses` block does, so a match that just missed is visible.
- Under `--yes`, run `RetireTranslation` per row, counting outcomes into the existing summary line.
- After the write loop, when **three or more** items were retired in this run, `await notifyOps(...)` with a message naming the count and the itemIds. Below three, nothing.
- The preview line must say how many retires `--yes` would perform, matching the existing wording for confirmed/external.

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Mutation-check the ordering test**

Swap the two writes in `RetireTranslation` so the history row goes first. The ordering test must fail. Restore.

- [ ] **Step 6: Verify the CLI against production in preview mode**

This command's own unit runs it with `--yes`, so the preview is the only safe rehearsal. From the repo root, **not** this worktree — `~/.herald/prod.env` and the real API key live there:

```bash
TWITTERAPI_IO_KEY=$(grep -m1 '^TWITTERAPI_IO_KEY=' /home/kyle/code/mantle-kr-herald/.env | cut -d= -f2-) \
  npx tsx --env-file=$HOME/.herald/prod.env src/cli/x-reconcile.ts --since 14d
```

Expected: the first line names `database production`; a `posted (5)` section listing the five itemIds from the spec's table; **nothing written** (`preview only`). If the count is not 5, stop and report — do not pass `--yes`.

- [ ] **Step 7: Commit**

```bash
git add src/app/RetireTranslation.ts src/shared/notifyOps.ts src/cli/x-reconcile.ts src/cli/xReconcileReport.ts tests/
git commit -m "feat(reconcile): retire a translation that already went out by hand"
```

---

### Task 5: The dashboard — locked, labelled, reversible

**Files:**
- Modify: `web/src/types.ts`, `web/src/components/TranslationList.tsx`, `web/src/components/TranslationDetail.tsx`, `src/adapters/web/apiHandlers.ts`, `src/app/createDeps.ts`
- Test: `tests/web/typeMirror.test.ts`, `web/tests/TranslationDetail.test.tsx` (create if absent — follow `web/tests/OutletCard.test.tsx` for setup), `tests/web/apiHandlers` tests (locate the existing file)

**Interfaces:**
- Consumes: `ALL_TRANSLATION_STATUSES`, `Translation.postedUrl`/`postedAt` (Task 2).
- Produces: route `POST /api/translations/:id/unretire`; `ApiDeps` gains `unretireTranslation: (itemId: string) => Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// typeMirror — the web copy of the vocabulary must not drift from the domain
it("mirrors ALL_TRANSLATION_STATUSES", () => {
  expect([...WEB_TRANSLATION_STATUSES]).toEqual([...ALL_TRANSLATION_STATUSES]);
});
```

```tsx
// TranslationDetail
it("locks a posted item: no edit, no 승인", () => {});
it("links the live post it was matched to", () => {});
it("offers 되돌리기 on a posted item and not on any other status", () => {});
it("shows the earlier match as a note on an item that was reverted (postedUrl set, status translated)", () => {});
```

```ts
// apiHandlers
it("POST /api/translations/:id/unretire moves it off posted and keeps postedUrl", async () => {});
it("returns 404 for an unknown id", async () => {});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `pnpm test`
Expected: FAIL on each new assertion.

- [ ] **Step 3: Implement**

Invariants:
- `web/src/types.ts` keeps a hand-written copy of the status vocabulary because the frontend cannot import the domain (`web/tsconfig.json` includes only `web/src`). Export it as an array in the same shape as `ALL_TYPES`/`ALL_CHANNELS` there, so `typeMirror` can compare it.
- **Lock, do not hide.** A `posted` item shows its Korean text read-only with editing and 승인 disabled — the reviewer must still be able to read what went out. Follow the existing disabled-control pattern in `TranslationDetail`; remember Tailwind v4 preflight resets `button` to `cursor: default`, and the repo's `styles.css` `@layer base` rule re-enables the pointer for enabled buttons only.
- `StatusChip` gains a third branch in a **neutral** colour — not the amber of 대기, not the mint of 승인 — so a glance distinguishes three states, and `TranslationList`'s `Filter` union and `FILTERS` array gain 게시됨.
- An item with `postedUrl` set but status back to `translated` renders as 대기 **plus** a note naming the live post; that is the reverted state and hiding the evidence would make the undo look like it lost information.
- The unretire route reuses `SaveTranslation` (`approve: false`) only if Task 2's preservation invariant genuinely holds; otherwise add a narrow store method. Either way `postedUrl` survives — that is what stops the next tick from re-retiring it.
- `createDeps.ts` wires `unretireTranslation` for both entry points. It is a plain database write with no credential, so unlike sends it is **not** gated by the hosted/local route split.

- [ ] **Step 4: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS on both projects.

- [ ] **Step 5: Verify in a browser**

A green suite and a clean review have both missed real dashboard defects in this repo before. Start the dashboard against a throwaway database, put one row in each of the three statuses, and check with playwright at 1280px and 390px: the chip colours are distinguishable, a `posted` row cannot be edited or approved, 되돌리기 works and the item reappears as 대기 with the note, and the live link opens the right post.

- [ ] **Step 6: Commit**

```bash
git add web/src src/adapters/web/apiHandlers.ts src/app/createDeps.ts tests/ web/tests/
git commit -m "feat(web): show a hand-posted item as 게시됨, locked and reversible"
```

---

### Task 6: Documentation and changelog

**Files:**
- Modify: `docs/ko/capabilities.md`, `docs/ko/team-runbook.md`, `docs/ko/review.md`, `CHANGELOG.md`
- Test: none — but grep for stale claims, which is the recurring defect class on this repo's doc changes.

- [ ] **Step 1: Find every sentence this branch falsifies**

```bash
grep -rn "translated\|approved\|검수 대기\|x:reconcile\|reconcile" docs/ko/ | grep -v "^docs/ko/setup/"
```

Read each hit. Anything that says a translation is either 검수 대기 or 승인됨 is now wrong. The known trap on this repo is a corrected sentence left beside a stale neighbour a few lines away — fix the paragraph, not the line.

- [ ] **Step 2: Write the changes**

- `capabilities.md` — `x:reconcile` now also recognises a hand-published translation and retires it to 게시됨.
- `team-runbook.md` — a 게시됨 item is terminal; 되돌리기 is how to dispute one; a run that retires three or more sends a Telegram notice.
- `review.md` — written for reviewers who never open a terminal: what the third chip means and that they do not need to act on it.
- `CHANGELOG.md` — one entry under `[Unreleased]`, English, in the house style: what changed and *why*, including the measured 0.216 separation and the fact that a hand-post is a rewrite. Do not date it or cut a version.

- [ ] **Step 3: Re-run the grep and confirm no stale claim survives**

- [ ] **Step 4: Commit**

```bash
git add docs/ CHANGELOG.md
git commit -m "docs: a translation can now end at 게시됨 without being approved"
```

---

## After the last task

Open the PR against `main` (never merge locally). In the body: the measurement table from the spec, the correction that the first draft's 0.057 margin was measured against mislabelled negatives, and the operational finding that five of nine production translations were already published by hand.

Then, and only then, re-arm the timer that was stopped for this work:

```bash
systemctl --user enable --now herald-x-reconcile.timer
```
