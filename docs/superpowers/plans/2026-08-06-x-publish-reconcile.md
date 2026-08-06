# X Publish Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read @0xMantleKR on a timer and update this system's records from what is actually published there — a delivery row when a live post is literally the copy we approved, a publish-history row when it is not.

**Architecture:** A pure verdict layer (`similarity` → confirmed / candidate / external) with no I/O, a pure plan-builder use case that also enforces idempotency against what is already recorded, and a thin CLI that executes the plan through the two existing writers (`RecordPublish` for history, a new small recorder for the delivery ledger). Its own systemd timer, not a stage in `pnpm watch`.

**Tech Stack:** TypeScript (Node 24, ESM, `tsx`), vitest, twitterapi.io via the existing gateway, Postgres, Google Sheets, systemd `--user` units.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-06-x-publish-reconcile-design.md`:

- **Confirmed at ≥ 0.95, candidate 0.50–0.95, external below 0.50.** The measured false positive (0.350) must land in **external**.
- **`MATCH_THRESHOLD` in `src/domain/kol/attribution.ts` is NOT changed.** It belongs to the KOL matcher; this feature carries its own constants.
- **Candidates are reported, never written.** `sent` is irreversible (`src/domain/delivery/models.ts:5`), so an unattended guess is the one mistake with no undo.
- **A confirmed match writes `status: "sent"`.** No new value is added to `ALL_DELIVERY_STATUSES`. `src/app/MarkDelivery.ts` is **not** modified — its refusal to let a human tick 전달함 on an `auto` outlet stays exactly as it is.
- **One row per thread, keyed on the root.** Per-reply rows are out of scope.
- **External posts get `itemId` = `kr:<rootId>`.** Never `x:` — `src/adapters/content/xArticleMeta.ts` short-circuits on ids that do not start with `x:`, and that short-circuit is the protection.
- **Preview unless `--yes`.** It writes to a shared team workbook and an irreversible ledger.
- **Never touches the collect watermark or `x_threads`.** That corpus is @Mantle_Official's English source content.
- **The two pre-existing `x-post` delivery rows** (`x:2080608995371597892`, `x:2080661810034917770`) record real sends to @bcd_kyle. They are history — the reconcile must skip them, never "correct" them.
- Telegram, KakaoTalk, a dashboard surface for candidates, and importing external posts as pipeline items are all out of scope.
- Code, comments, commit messages, CHANGELOG in **English**; `docs/ko/` in **Korean**.
- Verification: `pnpm test`, `pnpm typecheck`. No lint script.
- **This working tree is shared, and the live scheduler runs `pnpm watch` from it every two hours at :17.** Commit after every task so the tree is never dirty at a fire. Never `git add -A`. Stage only the files a task names.

---

### Task 1: The verdict, and the two records a thread can become

Pure domain. No I/O, no clock, no environment.

**Files:**
- Create: `src/domain/publish/xReconcile.ts`
- Create: `tests/domain/xReconcile.test.ts`

**Interfaces:**
- Consumes: `similarity`, `bestMatch`, `MatchCandidate` from `src/domain/kol/attribution.ts`; `AssembledThread` from `src/domain/models.ts` (`{ rootId: string; tweets: SourceTweet[] }`, tweets chronological, each with `id`, `text`, `createdAt`); `PublishRecord` from `src/domain/sheet/models.ts`; `DeliveryEntry` from `src/domain/delivery/models.ts`.
- Produces:
  - `CONFIRMED_AT = 0.95`, `CANDIDATE_AT = 0.5`
  - `type Verdict = { kind: "confirmed" | "candidate"; itemId: string; score: number } | { kind: "external"; score: number }`
  - `threadText(thread: AssembledThread): string`
  - `classify(thread: AssembledThread, candidates: MatchCandidate[]): Verdict`
  - `externalHistoryRecord(thread: AssembledThread, handle: string): PublishRecord`
  - `observedDelivery(itemId: string, type: string, thread: AssembledThread, handle: string): DeliveryEntry`
  - `postUrl(handle: string, rootId: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/xReconcile.test.ts`:

```ts
// tests/domain/xReconcile.test.ts
import { describe, it, expect } from "vitest";
import {
  CONFIRMED_AT,
  CANDIDATE_AT,
  classify,
  threadText,
  externalHistoryRecord,
  observedDelivery,
  postUrl,
} from "../../src/domain/publish/xReconcile";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tweet(id: string, text: string, createdAt: string): SourceTweet {
  return {
    id,
    conversationId: id,
    text,
    createdAt,
    authorUserName: "0xMantleKR",
  } as SourceTweet;
}

function thread(rootId: string, texts: string[], createdAt = "2026-08-01T00:00:00.000Z"): AssembledThread {
  return { rootId, tweets: texts.map((t, i) => tweet(i === 0 ? rootId : `${rootId}${i}`, t, createdAt)) };
}

const APPROVED = "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 완전한 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

describe("classify", () => {
  it("confirms an exact copy-paste", () => {
    // The whole point: Kyle pastes approved copy by hand, so the live text is the approved text.
    const v = classify(thread("1", [APPROVED]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("confirmed");
    expect(v.score).toBeGreaterThanOrEqual(CONFIRMED_AT);
    if (v.kind === "confirmed") expect(v.itemId).toBe("x:1");
  });

  it("calls an unrelated post external, even at the KOL matcher's threshold", () => {
    // Measured 2026-08-06: an unrelated @0xMantleKR post scored 0.350 against one of our renderings
    // — above MATCH_THRESHOLD = 0.3. Recording a delivery on that evidence would have written an
    // irreversible `sent` row for a post that is not ours. It must land in external, not candidate:
    // it is not ours, so it must not cost a human a confirmation either.
    const unrelated = "맨틀 한국 스쿼드에서 새로운 멤버를 찾습니다. 콘텐츠와 커뮤니티 활동을 통해 맨틀의 RWA 생태계를 알리는 일입니다.";
    const v = classify(thread("2", [unrelated]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("external");
    expect(v.score).toBeLessThan(CANDIDATE_AT);
  });

  it("is external when there are no candidates at all", () => {
    // The normal case: the pipeline has produced 3 x renderings ever against 47 live posts.
    const v = classify(thread("3", ["아무 관계 없는 글"]), []);
    expect(v.kind).toBe("external");
    expect(v.score).toBe(0);
  });

  it("reports a near-but-edited paste as a candidate rather than confirming it", () => {
    // A human pasted and then tweaked a sentence. Real, and exactly the band a person must judge:
    // writing `sent` on a guess is unrecoverable, so the middle band is reported and not written.
    const edited = APPROVED.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const v = classify(thread("4", [edited]), [{ itemId: "x:1", text: APPROVED }]);
    expect(v.kind).toBe("candidate");
    expect(v.score).toBeGreaterThanOrEqual(CANDIDATE_AT);
    expect(v.score).toBeLessThan(CONFIRMED_AT);
  });

  it("picks the best candidate, not merely a passing one", () => {
    const other = "완전히 다른 주제의 승인된 원고입니다. 여기에는 겹치는 문장이 없습니다.";
    const v = classify(thread("5", [APPROVED]), [
      { itemId: "x:other", text: other },
      { itemId: "x:right", text: APPROVED },
    ]);
    expect(v.kind).toBe("confirmed");
    if (v.kind === "confirmed") expect(v.itemId).toBe("x:right");
  });
});

describe("threadText", () => {
  it("joins a thread's tweets in order, so a thread matches copy written as one piece", () => {
    // Real threads on the account run root + up to six replies. The approved rendering is one
    // block of text, so matching a reply on its own would score every thread as external.
    const t = thread("6", ["첫 문장입니다.", "이어지는 문장입니다.", "마지막 문장입니다."]);
    const text = threadText(t);
    expect(text).toContain("첫 문장입니다.");
    expect(text).toContain("이어지는 문장입니다.");
    expect(text).toContain("마지막 문장입니다.");
    expect(text.indexOf("첫")).toBeLessThan(text.indexOf("마지막"));
  });
});

describe("record shapes", () => {
  const t = thread("2084128041543127356", ["당첨자 발표", "첫 번째", "두 번째"], "2026-08-03T04:03:40.000Z");

  it("gives an external post a kr: id, never an x: one", () => {
    // src/adapters/content/xArticleMeta.ts short-circuits on ids that do not start with "x:", and
    // that short-circuit is the protection: a kr: id can never trigger a lookup for a source post
    // that does not exist.
    const r = externalHistoryRecord(t, "0xMantleKR");
    expect(r.itemId).toBe("kr:2084128041543127356");
    expect(r.itemId.startsWith("x:")).toBe(false);
  });

  it("records one row for a whole thread, keyed on the root", () => {
    const r = externalHistoryRecord(t, "0xMantleKR");
    expect(r.postId).toBe("2084128041543127356");
    expect(r.publishedAt).toBe("2026-08-03T04:03:40.000Z");
    expect(r.channel).toBe("x");
    expect(r.outletId).toBe("x-post");
    expect(r.url).toBe("https://x.com/0xMantleKR/status/2084128041543127356");
  });

  it("writes a confirmed match as an observation, not as a human's claim", () => {
    // models.ts:5-6 — `sent` is an observation and is never reversed; `delivered` is a claim a human
    // can untick. A post read back off X with an id and a url is the observation.
    const e = observedDelivery("x:1", "x", t, "0xMantleKR");
    expect(e.status).toBe("sent");
    expect(e.itemId).toBe("x:1");
    expect(e.type).toBe("x");
    expect(e.outletId).toBe("x-post");
    expect(e.postId).toBe("2084128041543127356");
    expect(e.url).toBe("https://x.com/0xMantleKR/status/2084128041543127356");
    expect(e.at).toBe("2026-08-03T04:03:40.000Z");
    // A human pasted it, so the delivery was manual even though a machine noticed.
    expect(e.by).toBe("manual");
  });

  it("builds urls from the handle it is given, not a hardcoded account", () => {
    expect(postUrl("someoneElse", "99")).toBe("https://x.com/someoneElse/status/99");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test tests/domain/xReconcile.test.ts`
Expected: FAIL — cannot resolve `../../src/domain/publish/xReconcile`.

- [ ] **Step 3: Implement against these invariants**

Write it yourself; this project's plans state invariants rather than pasting code.

- `CONFIRMED_AT = 0.95` and `CANDIDATE_AT = 0.5`, both exported, each with a comment giving its justification: the only real measurement is the 0.350 false positive, identical text scores 1.0 by construction, and there is no measured true positive yet because no approved rendering has ever been posted to this account — so being wrong high (a real match demoted to a candidate, costing one confirmation) is the safe direction and being wrong low writes an irreversible row.
- `threadText` joins each tweet's `text` in the order `tweets` already holds (the type documents them as chronological) with `"\n\n"`. Do not re-sort.
- `classify` calls `bestMatch(threadText(thread), candidates)`. No match at all → `{ kind: "external", score: 0 }`. Otherwise band on the score: `>= CONFIRMED_AT` confirmed, `>= CANDIDATE_AT` candidate, else external — and an external verdict still carries the score it scored, so the CLI can report near-misses.

  > **Superseded during execution (2026-08-06, commit `839aa2f`).** `classify` does **not** call
  > `bestMatch`. That helper ends by discarding any score below `MATCH_THRESHOLD` (0.3) and returning
  > `undefined`, which truncates exactly the near-miss reporting the second half of this bullet asks
  > for: a thread that scored 0.26 against our copy collapsed to the same `score: 0` as a thread with
  > nothing to compare against at all. `classify` scores every candidate with `similarity` directly and
  > bands the real number, keeping `bestMatch`'s tie-break convention (first candidate in input order).
  > A reader following this bullet alone would reimplement that bug.
- `postUrl(handle, rootId)` → `https://x.com/${handle}/status/${rootId}`.
- `externalHistoryRecord` → `PublishRecord` with `itemId: kr:<rootId>`, `type: "x"`, `channel: "x"`, `outletId: "x-post"`, `postId: rootId`, `url: postUrl(...)`, `status: "posted"`, `publishedAt` = the **root** tweet's `createdAt` (the root is `tweets[0]` for an assembled thread; find it by `id === rootId` rather than assuming the index, and throw if it is absent — a thread whose root is missing is a bug worth failing on, not guessing past).

  > **Superseded during execution (2026-08-06, review).** "A thread whose root is missing is a bug worth
  > failing on" is **wrong about this codebase**, and it was this plan's most expensive sentence: a
  > missing root is a documented, common shape. `assembleThreads` keys on `conversationId || id` and
  > `conversationId` is the *root's* id, so every reply the account made into someone else's thread
  > assembles rootless — `CollectAuthoredContent.gapFillMissingRoots` exists for exactly that, and 85 of
  > the 196 @Mantle_Official threads in the committed corpus have it. Following this invariant literally
  > shipped a Critical: one reply to a partner account threw out of plan building, `registerErrorHandler`
  > exited 1, and the timer reconciled nothing every six hours until the reply aged past `--since`.
  >
  > **Right handling:** keep the domain-level throw here (it is correct for a hand-built thread — there
  > is no honest `publishedAt`/`postId` at this level, and `tweets[0]` would put another account's tweet
  > id in `postId` behind a url `impressions:record` then measures). Export the *question* —
  > `findRootTweet` — and have `reconcileXPublished` ask it per thread and route a rootless thread to
  > `skipped` with a reason naming the cause. Per-thread, never fatal.
- `observedDelivery` → `DeliveryEntry` with `status: "sent"`, `by: "manual"`, the same `postId`/`url`/`at` as above, `outletId: "x-post"`, and the `itemId`/`type` it is given.
- No `Date.now()`, no `process.env`, no imports from `src/adapters` or `src/cli`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm test tests/domain/xReconcile.test.ts && pnpm typecheck`
Expected: PASS and clean. If the "candidate" test's edited-paste fixture does not land between 0.5 and 0.95, **do not move the constants to make it pass** — adjust the fixture's edit until it sits in the band, and say so in your report. The constants are the spec's, the fixture is yours.

- [ ] **Step 5: Commit**

```bash
git add src/domain/publish/xReconcile.ts tests/domain/xReconcile.test.ts
git commit -m "feat(reconcile): verdicts for what is live on X, and the two rows a thread can become"
```

---

### Task 2: The plan builder, and idempotency

Still pure: it takes what is live and what is already recorded, and returns what to do. No writes.

**Files:**
- Create: `src/app/ReconcileXPublished.ts`
- Create: `tests/app/reconcileXPublished.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced; `ChannelRendering` from `src/domain/formatting/models.ts` (fields used here: `itemId`, `type`, `channel`, `text`, `status`); `deliveryKey` from `src/domain/delivery/models.ts`.
- Produces:
  - `xMatchCandidates(renderings: ChannelRendering[]): MatchCandidate[]`
  - `type ReconcilePlan = { confirmed: { entry: DeliveryEntry; score: number }[]; candidates: { rootId: string; itemId: string; score: number }[]; external: PublishRecord[]; skipped: { rootId: string; reason: string }[] }`
  - `reconcileXPublished(input: { threads: AssembledThread[]; renderings: ChannelRendering[]; deliveredKeys: Set<string>; historyIds: Set<string>; handle: string }): ReconcilePlan`

- [ ] **Step 1: Write the failing test**

Create `tests/app/reconcileXPublished.test.ts`:

```ts
// tests/app/reconcileXPublished.test.ts
import { describe, it, expect } from "vitest";
import { reconcileXPublished, xMatchCandidates } from "../../src/app/ReconcileXPublished";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function thread(rootId: string, texts: string[]): AssembledThread {
  const tweets = texts.map(
    (text, i) =>
      ({
        id: i === 0 ? rootId : `${rootId}${i}`,
        conversationId: rootId,
        text,
        createdAt: "2026-08-01T00:00:00.000Z",
        authorUserName: "0xMantleKR",
      }) as SourceTweet,
  );
  return { rootId, tweets };
}

const COPY = "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 완전한 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";

function rendering(itemId: string, text: string, over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId, type: "x", channel: "x", text, status: "approved", ...over } as ChannelRendering;
}

const base = { deliveredKeys: new Set<string>(), historyIds: new Set<string>(), handle: "0xMantleKR" };

describe("xMatchCandidates", () => {
  it("takes only approved x copy", () => {
    // An unapproved rendering is not something a human signed off, and telegram copy is a different
    // channel entirely — matching against either would attribute a live post to the wrong thing.
    const candidates = xMatchCandidates([
      rendering("x:ok", COPY),
      rendering("x:draft", COPY, { status: "rendered" }),
      rendering("x:tg", COPY, { channel: "telegram" }),
      rendering("x:empty", ""),
    ]);
    expect(candidates.map((c) => c.itemId)).toEqual(["x:ok"]);
  });
});

describe("reconcileXPublished", () => {
  it("confirms a pasted post and leaves everything else external", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY]), thread("200", ["당첨자 발표 이벤트 안내입니다. 참여해 주신 모든 분께 감사드립니다."])],
      renderings: [rendering("x:1", COPY)],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.itemId).toBe("x:1");
    expect(plan.confirmed[0].entry.postId).toBe("100");
    expect(plan.external.map((r) => r.itemId)).toEqual(["kr:200"]);
    expect(plan.candidates).toEqual([]);
  });

  it("skips a thread whose item already has an x-post delivery row", () => {
    // Idempotency: a second run must be a no-op. This is also what protects the two pre-existing
    // rows recording real sends to @bcd_kyle — they are history, not something to correct.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY])],
      renderings: [rendering("x:1", COPY)],
      deliveredKeys: new Set(["x:1:x:x-post"]),
    });

    expect(plan.confirmed).toEqual([]);
    expect(plan.external).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].rootId).toBe("100");
  });

  it("skips an external post already in publish history", () => {
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("300", ["파이프라인과 무관한 한국팀 자체 공지입니다."])],
      renderings: [],
      historyIds: new Set(["kr:300"]),
    });

    expect(plan.external).toEqual([]);
    expect(plan.skipped.map((s) => s.rootId)).toEqual(["300"]);
  });

  it("reports a candidate without putting it in either write list", () => {
    const edited = COPY.replace("진짜 과제가 시작됩니다", "이제부터가 본론입니다") + " 자세한 내용은 아래에서 확인하세요.";
    const plan = reconcileXPublished({ ...base, threads: [thread("400", [edited])], renderings: [rendering("x:1", COPY)] });

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].rootId).toBe("400");
    expect(plan.candidates[0].itemId).toBe("x:1");
    expect(plan.confirmed).toEqual([]);
    // A candidate is NOT silently filed as external either — that would record it under a kr: id
    // and then a human confirming the match later would have two rows for one post.
    expect(plan.external).toEqual([]);
  });

  it("never confirms the same item twice in one run", () => {
    // Two live threads both matching one rendering: the second is a re-post or a near-duplicate, and
    // one item can only have one x-post row. The first (oldest) wins and the other is reported.
    const plan = reconcileXPublished({
      ...base,
      threads: [thread("100", [COPY]), thread("101", [COPY])],
      renderings: [rendering("x:1", COPY)],
    });

    expect(plan.confirmed).toHaveLength(1);
    expect(plan.confirmed[0].entry.postId).toBe("100");
    expect(plan.candidates.map((c) => c.rootId)).toEqual(["101"]);
  });

  it("returns empty lists for no live threads rather than throwing", () => {
    const plan = reconcileXPublished({ ...base, threads: [], renderings: [rendering("x:1", COPY)] });
    expect(plan).toEqual({ confirmed: [], candidates: [], external: [], skipped: [] });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test tests/app/reconcileXPublished.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement against these invariants**

- `xMatchCandidates` keeps only `status === "approved" && channel === "x" && text !== ""`, mapping to `{ itemId, text }`. Read `src/app/telegramMatchCandidates.ts` first — it is the same shape for the other channel and its doc comment explains why each filter is there.
- `reconcileXPublished` walks `threads` in the order given and, per thread:
  - `classify` against the candidates.
  - **Confirmed** → skip with a reason if `deliveryKey({ itemId, type, outletId: "x-post" })` is already in `deliveredKeys`, or if this run already confirmed that itemId; otherwise push `{ entry: observedDelivery(...), score }` and remember the itemId as taken. A confirmed match displaced by either rule becomes a **candidate**, not an external row — recording it under `kr:` would leave two rows for one post if a human later confirms the match.
  - **Candidate** → push to `candidates`. Never to `confirmed` or `external`.
  - **External** → skip with a reason if `kr:<rootId>` is in `historyIds`; otherwise push `externalHistoryRecord(...)`.
  - `type` for a confirmed entry comes from the matched rendering's own `type`, not a literal — a rendering carries the type it was formatted for.
- No I/O, no clock. Every timestamp comes from the thread.
- Deterministic: same input, same plan, same order.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm test tests/app/reconcileXPublished.test.ts && pnpm typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/ReconcileXPublished.ts tests/app/reconcileXPublished.test.ts
git commit -m "feat(reconcile): build the plan, and make a second run a no-op"
```

---

### Task 3: The recorder and the CLI

**Files:**
- Create: `src/app/RecordObservedDelivery.ts`
- Create: `tests/app/recordObservedDelivery.test.ts`
- Create: `src/cli/x-reconcile.ts`
- Modify: `package.json` (one script line)

**Interfaces:**
- Consumes: `ReconcilePlan` and `reconcileXPublished` (Task 2); `DeliveryLedger` from `src/ports/DeliveryLedger.ts` (`loadKeys(): Promise<Set<string>>`, `add(entry: DeliveryEntry): Promise<void>`); `RecordPublish` from `src/app/RecordPublish.ts` (`record(rec: PublishRecord): Promise<void>`).
- Produces: `RecordObservedDelivery` class with `record(entry: DeliveryEntry): Promise<"written" | "already-recorded">`; `pnpm x:reconcile`.

- [ ] **Step 1: Write the failing test**

Create `tests/app/recordObservedDelivery.test.ts`:

```ts
// tests/app/recordObservedDelivery.test.ts
import { describe, it, expect } from "vitest";
import { RecordObservedDelivery } from "../../src/app/RecordObservedDelivery";
import { deliveryKey, type DeliveryEntry } from "../../src/domain/delivery/models";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";

function fakeLedger(existing: string[] = []) {
  const added: DeliveryEntry[] = [];
  const keys = new Set(existing);
  const ledger: DeliveryLedger = {
    async loadAll() { return []; },
    async loadKeys() { return keys; },
    async add(e) { added.push(e); keys.add(deliveryKey(e)); },
    async remove() {},
    async replace() {},
  } as unknown as DeliveryLedger;
  return { ledger, added };
}

const entry: DeliveryEntry = {
  itemId: "x:1",
  type: "x",
  outletId: "x-post",
  status: "sent",
  at: "2026-08-01T00:00:00.000Z",
  by: "manual",
  postId: "100",
  url: "https://x.com/0xMantleKR/status/100",
};

describe("RecordObservedDelivery", () => {
  it("writes an observation the ledger does not have", async () => {
    const { ledger, added } = fakeLedger();
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("written");
    expect(added).toEqual([entry]);
  });

  it("refuses to overwrite an existing row, and says so instead of throwing", async () => {
    // `sent` is never reversed, so the existing row is the record. Re-writing it could only change
    // a real send's post id to something a match guessed — and the caller needs to keep going
    // through the rest of the plan rather than abort on the first already-done row.
    const { ledger, added } = fakeLedger(["x:1:x:x-post"]);
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("already-recorded");
    expect(added).toEqual([]);
  });

  it("cannot be used to write anything but an observation", async () => {
    // The class exists so that observing X is the *only* way an auto outlet gains a row without a
    // bot having sent it. MarkDelivery still refuses a human's `delivered` claim on an auto outlet;
    // this must not become a back door for one.
    const { ledger } = fakeLedger();
    await expect(
      new RecordObservedDelivery(ledger).record({ ...entry, status: "delivered" }),
    ).rejects.toThrow(/observation/i);
  });

  it("requires the evidence that makes it an observation", async () => {
    // No post id means nothing was observed — it is a claim wearing an observation's status.
    const { ledger } = fakeLedger();
    await expect(new RecordObservedDelivery(ledger).record({ ...entry, postId: undefined })).rejects.toThrow(/postId/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm test tests/app/recordObservedDelivery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the recorder**

- Constructor takes the `DeliveryLedger`. `record` refuses (throws) unless `status === "sent"` and `postId` is present, with messages naming the reason — the doc comment must say why: this is the one path by which an `auto` outlet gains a row without a bot send, and it must not become a back door for the `delivered` claim `MarkDelivery` deliberately refuses.
- Returns `"already-recorded"` (not a throw) when `deliveryKey(entry)` is already in `loadKeys()`, so the caller can walk a whole plan.
- Writes through `ledger.add`. Nothing else.

> **Superseded during execution (2026-08-06, review).** `loadKeys()` is the wrong question to gate on.
> Every ledger filters it through `deliveredToRoom`, so a `dropped` row for the same key is *absent*
> from it — and `ledger.add` is an upsert — which meant a `dropped` row was silently rewritten to
> `sent` and reported as `✓ recorded`, against a doc comment claiming nothing is ever overwritten. Read
> `loadAll()` and apply `deliveredToRoom` here instead, so the class decides the distinction rather
> than inheriting it: an existing `sent`/`delivered` row → `"already-recorded"`; a `dropped` row →
> overwrite (a live post is newer, stronger evidence than a deleted draft) but return a **third**
> outcome, `"replaced-dropped"`, and have the CLI print it as one.
>
> Task 2's `reconcileXPublished` input also gained `historyPostIds` for the same class of reason: the
> `history` tab's real identity for an X row is its `postId` (column D), not the `itemId` in column A,
> so `historyIds` alone let a post already recorded under a different itemId gain a second row.

- [ ] **Step 4: Write the CLI**

Create `src/cli/x-reconcile.ts`. Read `src/cli/collect-reference.ts` and `src/cli/impressions-record.ts` first — between them they show every piece of wiring this needs. Invariants:

- `import "./registerErrorHandler";` first, then `skipIfLocal("x:reconcile")`.
- Handle: `process.env.REFERENCE_X_HANDLE?.trim().replace(/^@/, "") || "0xMantleKR"` — the exact expression `metrics-record.ts:16` uses.
- `--since` parsed with `parseSince` from `src/shared/time/parseSince.ts` (accepts `12h`/`3d`/`1w` or an ISO date), defaulting to `30d`. `--handle` overrides the env. `--yes` enables writes.
- Read live posts with `TwitterApiSourceGateway.fetchAuthoredTweets(handle, since)`, drain the generator, then `assembleThreads`. **Never** pass the result to a collection repository and never touch a watermark.
- Load approved renderings from `createStores(db).formattingStore.loadAll()`, delivery keys from `deliveryLedger.loadKeys()`, and the set of history ids by reading the `history` tab through the same `GoogleSheetClient` the siblings build — column A of `history!A2:A` is enough, and a missing tab means an empty set, not a crash.
- Build the plan with `reconcileXPublished`, then print a summary of all four lists — confirmed with scores, candidates with scores **and** their root ids so a human can open them, external counts, skipped counts.
- Without `--yes`: print and exit 0, writing nothing. With `--yes`: write confirmed rows via `RecordObservedDelivery`, external rows via `RecordPublish`, and report per-row outcomes. Close the database in a `finally`.
- Exit non-zero only on a real failure (a write that threw). Candidates are not a failure.

- [ ] **Step 5: Add the script**

In `package.json`, beside the other `tsx --env-file-if-exists=.env` entries:
`"x:reconcile": "tsx --env-file-if-exists=.env src/cli/x-reconcile.ts"`

- [ ] **Step 6: Run the full suite, typecheck, and the CLI's own preview**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS, clean.

Then prove the CLI reads reality without writing:
`pnpm x:reconcile --since 3d 2>&1 | tail -20`
It runs against the **local** database (the repo's `.env`) — which may be unreachable; if it is, report that rather than pointing it at production. Either way it must not write: confirm the output says preview and names no write. Do **not** run it with `--yes`.

- [ ] **Step 7: Commit**

```bash
git add src/app/RecordObservedDelivery.ts tests/app/recordObservedDelivery.test.ts src/cli/x-reconcile.ts package.json
git commit -m "feat(reconcile): record an observation, and a CLI that previews before it writes"
```

---

### Task 4: The timer, and the bound that keeps it honest

**Files:**
- Create: `deploy/herald-x-reconcile.service`
- Create: `deploy/herald-x-reconcile.timer`
- Create: `tests/deploy/xReconcileTiming.test.ts`

**Interfaces:** none — deploy files and an assertion over them.

- [ ] **Step 1: Write the units**

Read `deploy/herald-watch.service` and `deploy/herald-watch.timer` first and follow them closely: same `WorkingDirectory`, the same absolute-path `Environment=PATH=` (those paths were found with `command -v` on this one machine), the same `EnvironmentFile=%h/.herald/prod.env`, the same `OnFailure=herald-notify-failure.service`, `Type=oneshot`.

> **Superseded during execution (2026-08-06, commit `529c045`).** Reusing "the same
> `OnFailure=herald-notify-failure.service`" does not work: that hook hardcoded `herald-watch.service`
> inside `herald-notify-failure.sh`, so whichever unit did *not* get the hardcoded name reported the
> wrong unit's name and tailed the wrong unit's journal on failure — a failure notice that points at a
> healthy unit. The hook became a template, `herald-notify-failure@.service` taking the failing unit's
> name via `%i`, and **both** units now set `OnFailure=herald-notify-failure@%n.service` (the idiom
> `man systemd.unit`'s own `OnFailure=` example uses). Installing it is therefore not additive: the old
> non-templated `herald-notify-failure.service` must be removed from `~/.config/systemd/user/` and
> `herald-watch.service` re-copied, and the failure drill re-run starting with `herald-watch` — see the
> runbook's "X 발행 재확인" section. A reader following this bullet alone would reimplement the
> wrong-unit-named bug.

Differences, each of which needs a comment saying why:
- `ExecStart=` runs `pnpm x:reconcile --yes`. The timer is the only caller that passes `--yes`; a human previews.
- **No `HERALD_OUTPUT_DIR`.** This command reads X and writes Postgres and a sheet; it never touches an output tree, so pointing it at one would only imply it does.
- **No `HERALD_TRANSLATE_SINCE`, no `HERALD_WATCH_BATCH`.** Neither is read by this command.
- `TimeoutStartSec=600`. This makes no `claude -p` call at all — its cost is one paged X read plus a bounded number of sheet and database round trips — so it needs nothing like the watch tick's 1800s.
- `OnCalendar=*-*-* 0/6:41:00` — every six hours at :41. Posts are reconciled, not raced: a hand-posted tweet does not need to be recorded within minutes, and a slower cadence keeps the twitterapi.io spend and the sheet round trips low. `:41` keeps it off both `:00` and `herald-watch`'s `:17`, so the two never contend for the same minute.
- `Persistent=true`, same reasoning as the watch timer: a fire missed while the machine was off should run once on the next boot rather than being skipped.

- [ ] **Step 2: Write the timing test**

Create `tests/deploy/xReconcileTiming.test.ts`. Read `tests/deploy/watchTiming.test.ts` first — this is its sibling and keeps its own local helpers for the same reason. Same shape, pointed at the new pair, plus one assertion that file does not need:

```ts
// tests/deploy/xReconcileTiming.test.ts
//
// The sibling of tests/deploy/watchTiming.test.ts, for the reconcile pair. Same constraint, same
// reason: systemd skips an OnCalendar= fire that comes due while the unit is still active, so a
// TimeoutStartSec= larger than the fire period turns one wedged run into a timer that looks armed
// and has silently stopped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const timer = readFileSync(resolve(repoRoot, "deploy/herald-x-reconcile.timer"), "utf8");
const service = readFileSync(resolve(repoRoot, "deploy/herald-x-reconcile.service"), "utf8");
const watchTimer = readFileSync(resolve(repoRoot, "deploy/herald-watch.timer"), "utf8");

function onCalendarLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("OnCalendar="));
}

function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(service)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/** Period in seconds for the two shapes these timers use; `undefined` for anything else. */
function periodSeconds(spec: string): number | undefined {
  const everyNHours = /^\*-\*-\* \d+\/(\d+):\d{2}:\d{2}$/.exec(spec);
  if (everyNHours) return Number(everyNHours[1]) * 3600;
  if (/^\*-\*-\* \*:\d{2}:\d{2}$/.test(spec)) return 3600;
  return undefined;
}

function minuteOf(spec: string): string | undefined {
  return /:(\d{2}):\d{2}$/.exec(spec)?.[1];
}

describe("x-reconcile timer", () => {
  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    expect(onCalendarLines(timer)).toHaveLength(1);
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("uses a shape this file can read, and sets the timeout as plain seconds", () => {
    const spec = onCalendarLines(timer)[0].slice("OnCalendar=".length).trim();
    expect(periodSeconds(spec)).toBeDefined();
    expect(timeoutStartSec()).toBeDefined();
  });

  it("keeps the timeout at or under half the fire period", () => {
    const spec = onCalendarLines(timer)[0].slice("OnCalendar=".length).trim();
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(spec)! / 2);
  });

  it("does not fire in the same minute as herald-watch", () => {
    // Both units run `pnpm` from the same working tree against the same database. Sharing a minute
    // buys nothing and invites two pnpm processes installing at once on a cold store.
    const mine = minuteOf(onCalendarLines(timer)[0]);
    const watch = minuteOf(onCalendarLines(watchTimer)[0]);
    expect(mine).toBeDefined();
    expect(mine).not.toBe(watch);
  });

  it("refuses shapes it cannot read instead of guessing a period", () => {
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "*-*-* 0/6:41", ""]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });

  it("reads the shapes it claims to read", () => {
    expect(periodSeconds("*-*-* 0/6:41:00")).toBe(21600);
    expect(periodSeconds("*-*-* *:41:00")).toBe(3600);
  });
});
```

- [ ] **Step 3: Run it**

Run: `pnpm test tests/deploy/xReconcileTiming.test.ts`
Expected: all PASS.

- [ ] **Step 4: Run the full suite and commit**

Committing before the next step is deliberate: these files are untracked until now, so `git checkout` cannot restore them, and the next step edits one on purpose.

Run: `pnpm test && pnpm typecheck`

```bash
git add deploy/herald-x-reconcile.service deploy/herald-x-reconcile.timer tests/deploy/xReconcileTiming.test.ts
git commit -m "deploy(reconcile): its own timer, bounded against its own period"
```

- [ ] **Step 5: Prove the bound bites, now that it can be reverted**

A test never seen red is a test nobody has verified. Set `TimeoutStartSec=` in `deploy/herald-x-reconcile.service` to `20000` and re-run.

Run: `pnpm test tests/deploy/xReconcileTiming.test.ts`
Expected: "keeps the timeout at or under half the fire period" FAILS — 20000 > 10800.

Then revert and confirm green again:

```bash
git checkout deploy/herald-x-reconcile.service
pnpm test tests/deploy/xReconcileTiming.test.ts
```

Report both observations, and confirm `git status` is clean afterwards.

---

### Task 5: Documentation

**Files:**
- Modify: `docs/ko/team-runbook.md` (§6, after the watch scheduler's own subsections)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `.env.example` (only if this feature reads a variable the file does not already document — check `REFERENCE_X_HANDLE`, which is already there, before adding anything)

**Interfaces:** none.

- [ ] **Step 1: Write the runbook section**

In Korean, matching §6's voice. Read the watch scheduler's install and 확인 subsections first, then add a subsection for this timer covering: what it does in one sentence (X에 실제로 올라간 글을 읽어 기록을 맞춥니다), that it is read-then-record and never posts anything, the install steps (copy both units to `~/.config/systemd/user/`, `daemon-reload`, `enable --now`) — **and that the copy systemd reads is the one in `~/.config/systemd/user/`, not `deploy/`**, the same trap already documented for the batch dial.

Then the three verdicts, in a table, with what each means for the operator: 확정 = 보드가 발송됨으로 바뀝니다 · 후보 = 저널에만 보고되고 아무것도 쓰지 않으니 사람이 판단합니다 · 외부 = 파이프라인을 거치지 않은 글이며 게시 이력에만 남습니다. State plainly that a 후보 is the normal outcome of pasting-then-editing, and that nothing will act on it until a human does.

Also: how to run it by hand to look before it writes (`pnpm x:reconcile --since 7d`, no `--yes`), and that the timer is the only caller that passes `--yes`.

- [ ] **Step 2: Write the CHANGELOG entry**

Under `### Added` in `## [Unreleased]`, in English, matching the surrounding entries' length and specificity. Cover: what it does and why the account rather than the board is the record (three routes to a published post, only one leaves a trace); the three verdicts and that candidates are reported and never written because `sent` is irreversible; that it carries its own thresholds and deliberately does not touch `MATCH_THRESHOLD`, with the measured 0.350 false positive as the reason; that a confirmed match writes `sent` because `models.ts` already defines that as an observation, so `MarkDelivery`'s refusal on `auto` outlets is unchanged; and that external posts land in publish history under `kr:` ids, which is also what gives `impressions:record` X rows to measure.

- [ ] **Step 3: Verify and commit**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS — `.env.example`'s own guard test (`tests/config/envExample.test.ts`) will fail if you documented a variable nothing reads, so if you added one, check it.

```bash
git add docs/ko/team-runbook.md CHANGELOG.md
git commit -m "docs(reconcile): what the three verdicts mean for the person reading the journal"
```

---

## Notes for the implementer

- **The live scheduler runs `pnpm watch` from this working tree every two hours at :17.** Commit at the end of every task so the tree is never mid-edit when it fires. Nothing in this plan modifies `src/cli/watch.ts` or any stage the tick runs, so a committed, tested branch is safe for it — a half-written shared file is not.
- **Run `git status` before each task and stage only the files it names.** Other sessions share this tree. Never `git add -A`.
- **Do not write `.env`.** `.env.example` only.
- **Do not run `pnpm x:reconcile --yes`.** The preview path is what this plan verifies; the first real write is a human-supervised step after review, against production, with the plan printed first.
- **Do not change `MATCH_THRESHOLD`,** and do not modify `src/app/MarkDelivery.ts`, `src/app/SendChannels.ts`, or `src/app/CollectAuthoredContent.ts`.
- If a test you were told would pass fails instead, stop and report rather than adjusting the assertion. The one exception is Task 1 Step 4's fixture, which is explicitly yours to tune.
