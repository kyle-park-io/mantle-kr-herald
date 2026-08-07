# Published Text Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the Korean text @0xMantleKR actually published alongside the translation we produced, and read the glossary against it.

**Architecture:** A new nullable `translations.published_text` column, filled by a pure capture rule that runs inside `reconcileXPublished` and is completely independent of the retire path. The rule fills empty cells only, from threads reconcile already fetched. Two read-only glossary reports consume it.

**Tech Stack:** TypeScript, vitest, PGlite (tests), Postgres (production), tsx CLIs.

**Spec:** `docs/superpowers/specs/2026-08-07-published-text-capture-design.md`

## Global Constraints

- **Test style in this plan:** tests are written out as literal code; implementation steps are stated as invariants plus the exact files to read. Do not paste implementation snippets from this document — write the code from the invariants against the real file. (Embedded implementation snippets get their bugs reproduced verbatim; that is why they are absent here.)
- **TDD is mandatory.** Every step pair is: write the failing test, run it, watch it fail for the stated reason, then implement. A test that passes on first run means it is testing existing behaviour — fix the test.
- **Code, comments, and commit messages in English.** Korean only inside test fixtures and user-facing CLI strings.
- **Report, never gate.** No new code path throws on a finding. Failures are counted and printed. This is the standing convention — see `checkGlossary`'s doc comment in `src/domain/translation/glossaryCompliance.ts`.
- **Fill-only, never overwrite.** No step in this plan may write over a `published_text` that already has a value.
- **Store exactly what X returned.** No `stripMedia`, no marker normalisation, no trimming anywhere in the capture path.
- **`pnpm db:migrate` is required** after Task 1 before any run against a real database. No CLI applies the schema on its own.
- Full suite must be green (`pnpm vitest run`) and `pnpm typecheck` clean before each commit.

---

### Task 1: Storage — schema, domain field, Postgres round-trip

**Files:**
- Modify: `src/domain/translation/models.ts` (the `Translation` interface, near `postedUrl`/`postedAt` at :56-67)
- Modify: `src/adapters/db/schema.ts:25-33` (`ALTERED_COLUMNS`)
- Modify: `src/adapters/store/PgTranslationStore.ts` (all four places `posted_url` appears: `TranslationRow` :17, `toTranslation` :32, `loadAll`'s select :52-53, `upsert`'s insert/update/params :62-89)
- Test: `tests/adapters/store/PgTranslationStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Translation.publishedText?: string` — every later task reads or writes this field.

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/store/PgTranslationStore.test.ts` (reuse whatever row factory the file already defines; the two assertions below are what matter):

```typescript
it("round-trips publishedText", async () => {
  db = await createTestDb();
  const store = new PgTranslationStore(db);
  await store.upsert(translation({ itemId: "x:1", publishedText: "실제로 올라간 한국어" }));
  const [row] = await store.loadAll();
  expect(row.publishedText).toBe("실제로 올라간 한국어");
});

it("omits publishedText entirely when the column is null", async () => {
  // omitNulls contract: an absent value must not come back as `null`, or every
  // `publishedText === undefined` check downstream silently stops working.
  db = await createTestDb();
  const store = new PgTranslationStore(db);
  await store.upsert(translation({ itemId: "x:2" }));
  const [row] = await store.loadAll();
  expect("publishedText" in row).toBe(false);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run tests/adapters/store/PgTranslationStore.test.ts`
Expected: a TypeScript error on `publishedText` not existing on `Translation`, or the first assertion failing with `undefined`.

- [ ] **Step 3: Implement**

Invariants:
- `Translation.publishedText` is optional and typed `string`. Document it the way `postedUrl`/`postedAt` are documented: what it is (the live post's body as read off the account), and that nothing normalises it.
- The `ALTERED_COLUMNS` entry uses the same shape as the two `translations` entries already there. Do not hand-write an `alter table` statement — that file has exactly one place the SQL shape is written, and it is driven by this list.
- `PgTranslationStore` must be updated in **all four** places `posted_url` appears. A column added to `upsert`'s insert list but not its `on conflict do update set` list would silently stop persisting edits.
- `toTranslation` goes through `omitNulls`, which is what makes the second test pass — do not special-case it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run tests/adapters/store/PgTranslationStore.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: all green. Any other test that asserts a whole `Translation` object shape may need `publishedText` added — fix those assertions, not the implementation.

- [ ] **Step 6: Commit**

```bash
git add src/domain/translation/models.ts src/adapters/db/schema.ts src/adapters/store/PgTranslationStore.ts tests/adapters/store/PgTranslationStore.test.ts
git commit -m "feat(translations): add a published_text column for the copy that actually went out"
```

---

### Task 2: The capture rule (pure)

**Files:**
- Create: `src/domain/publish/publishedTextCapture.ts`
- Test: `tests/domain/publish/publishedTextCapture.test.ts`

**Read first:** `src/domain/publish/xReconcile.ts` — `threadText` (:70), `parsePostUrl` (:183), and the handle comparison inside `settledTranslationDisposition` (:392, case-insensitive on purpose).

**Interfaces:**
- Consumes: `Translation.publishedText` from Task 1; `threadText`, `parsePostUrl` from `xReconcile.ts`.
- Produces:
  ```typescript
  export interface PublishedTextCapture { itemId: string; rootId: string; text: string }
  export function capturePublishedTexts(input: {
    translations: Translation[];
    threads: AssembledThread[];
    posted: { itemId: string; rootId: string }[];
    handle: string;
  }): PublishedTextCapture[]
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/domain/publish/publishedTextCapture.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { capturePublishedTexts } from "../../../src/domain/publish/publishedTextCapture";
import type { AssembledThread, SourceTweet } from "../../../src/domain/models";
import type { Translation } from "../../../src/domain/translation/models";

const thread = (rootId: string, text: string): AssembledThread => ({
  rootId,
  tweets: [{
    id: rootId, conversationId: rootId, text, createdAt: "2026-08-01T00:00:00.000Z",
    url: `https://x.com/0xMantleKR/status/${rootId}`, authorUserName: "0xMantleKR",
    isReply: false, isQuote: false,
  } satisfies SourceTweet],
});

const tr = (over: Partial<Translation> = {}): Translation => ({
  itemId: "x:1", source: "x", sourceText: "en", koreanText: "우리 초안",
  status: "posted", translatedAt: "2026-08-01T00:00:00.000Z", ...over,
});

const handle = "0xMantleKR";

describe("capturePublishedTexts", () => {
  it("captures a settled translation from its postedUrl", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("captures a translation this run just retired, which has no postedUrl yet", () => {
    const t = tr({ status: "translated" });
    const out = capturePublishedTexts({
      translations: [t], threads: [thread("999", "올라간 글")],
      posted: [{ itemId: "x:1", rootId: "999" }], handle,
    });
    expect(out).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("never overwrites a cell that already has a value", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999", publishedText: "이미 있음" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "다른 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a translation whose post is not in this run's pool", () => {
    // Aged out of the --since window. The cell stays empty; a later, wider run fills it.
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("111", "다른 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a translation with no post id at all", () => {
    const out = capturePublishedTexts({ translations: [tr({ status: "translated" })], threads: [thread("999", "x")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a postedUrl pointing at another account", () => {
    // Mirrors settledTranslationDisposition's own foreign-account guard: a well-formed url for a
    // different handle is not this run's to read.
    const t = tr({ postedUrl: "https://x.com/SomeoneElse/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("matches the handle case-insensitively", () => {
    // An X handle is case-insensitive; `--handle 0xmantlekr` names the same account.
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle: "0xmantlekr" });
    expect(out).toHaveLength(1);
  });

  it("skips a malformed postedUrl instead of guessing", () => {
    const t = tr({ postedUrl: "not a url" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("treats an empty-string publishedText as empty and fills it", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999", publishedText: "" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toHaveLength(1);
  });

  it("joins a multi-tweet thread the same way scoring does", () => {
    const multi: AssembledThread = {
      rootId: "999",
      tweets: [
        { ...thread("999", "첫 트윗").tweets[0] },
        { ...thread("999", "둘째 트윗").tweets[0], id: "1000", isReply: true },
      ],
    };
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const [captured] = capturePublishedTexts({ translations: [t], threads: [multi], posted: [], handle });
    expect(captured.text).toContain("첫 트윗");
    expect(captured.text).toContain("둘째 트윗");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run tests/domain/publish/publishedTextCapture.test.ts`
Expected: all 10 fail — the module does not exist.

- [ ] **Step 3: Implement**

Invariants:
- Pure. No clock, no I/O, no `process.env`.
- The thread body must be produced by `threadText` from `xReconcile.ts`, not by a local join. Scoring uses `threadText`; a second joining rule here would store a body that differs from the one the score was computed against.
- A translation is a candidate only when `publishedText` is `undefined` or `""`.
- The post id comes from `posted` first (this run's fresh retires carry `rootId` directly), and from `parsePostUrl(postedUrl)` otherwise. `parsePostUrl` returns `undefined` for a malformed url — skip, never guess.
- A parsed handle that differs from `input.handle` (compared case-insensitively) is skipped.
- Output order follows `translations` order, so the CLI's printed list is stable across runs.
- At most one capture per itemId.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run tests/domain/publish/publishedTextCapture.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/publish/publishedTextCapture.ts tests/domain/publish/publishedTextCapture.test.ts
git commit -m "feat(reconcile): add the pure rule that decides which published texts to capture"
```

---

### Task 3: Surface captures on the reconcile plan

**Files:**
- Modify: `src/app/ReconcileXPublished.ts` — `ReconcilePlan` (:137-144) and the end of `reconcileXPublished` (after Phase B's loop, around :600)
- Test: `tests/app/reconcileXPublished.test.ts`

**Interfaces:**
- Consumes: `capturePublishedTexts` from Task 2.
- Produces: `ReconcilePlan.captures: PublishedTextCapture[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/reconcileXPublished.test.ts`, using that file's existing helpers for building threads/translations/renderings:

```typescript
describe("published text capture", () => {
  it("captures a freshly retired translation", () => {
    // The Phase B path: our draft matched a hand-posted thread this run.
    const plan = reconcileXPublished({
      threads: [threadOf("999", "가장 최근에 구매한 토큰화 자산은 무엇인가요?")],
      renderings: [],
      translations: [translationOf({ itemId: "x:1", koreanText: "가장 최근에 구매하신 토큰화 자산은 무엇입니까?" })],
      deliveredKeys: new Set(),
      historyIds: new Set(),
      historyPostIds: new Set(),
      handle: "0xMantleKR",
    });
    expect(plan.posted).toHaveLength(1);
    expect(plan.captures).toEqual([
      { itemId: "x:1", rootId: "999", text: "가장 최근에 구매한 토큰화 자산은 무엇인가요?" },
    ]);
  });

  // THE regression guard for this feature. xReconcile.ts:427 returns `retire: false` for a settled
  // translation whose post already carries a history row — it never re-enters plan.posted. All 14
  // translations retired on 2026-08-07 are in exactly that state, so a capture hanging off the
  // retire path would back-fill none of them, silently, forever.
  it("captures a settled translation whose post already has a history row and is NOT re-retired", () => {
    const plan = reconcileXPublished({
      threads: [threadOf("999", "올라간 글")],
      renderings: [],
      translations: [translationOf({
        itemId: "x:1",
        status: "posted",
        postedUrl: "https://x.com/0xMantleKR/status/999",
        postedAt: "2026-08-01T00:00:00.000Z",
      })],
      deliveredKeys: new Set(),
      historyIds: new Set(),
      historyPostIds: new Set(["999"]),   // history already written → retire: false
      handle: "0xMantleKR",
    });
    expect(plan.posted).toEqual([]);      // proves the retire path would have missed it
    expect(plan.captures).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("captures nothing when every settled row already has its published text", () => {
    const plan = reconcileXPublished({
      threads: [threadOf("999", "올라간 글")],
      renderings: [],
      translations: [translationOf({
        itemId: "x:1", status: "posted",
        postedUrl: "https://x.com/0xMantleKR/status/999",
        postedAt: "2026-08-01T00:00:00.000Z",
        publishedText: "이미 있음",
      })],
      deliveredKeys: new Set(),
      historyIds: new Set(),
      historyPostIds: new Set(["999"]),
      handle: "0xMantleKR",
    });
    expect(plan.captures).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run tests/app/reconcileXPublished.test.ts`
Expected: fails on `plan.captures` being `undefined`.

- [ ] **Step 3: Implement**

Invariants:
- `captures` is initialised alongside the other plan arrays at `ReconcileXPublished.ts:327` so the plan object always has the key, even on an empty run.
- The call to `capturePublishedTexts` happens **after** Phase B, so `plan.posted` is complete and this run's fresh retires are included.
- It reads `plan.posted` (mapping to `{ itemId, rootId }`), the full `translations` list, and the full `threads` list. Not `availableThreads`, not the claimed/released sets — capture is independent of claiming, and a thread claimed by a retire is exactly the thread we want to read.
- Nothing in Phase A, Phase B, `settledTranslationDisposition`, or the post-condition checks changes. If a diff touches those, it is wrong.
- Document `captures` on `ReconcilePlan` with one line on why it is not derived from `posted`.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run tests/app/reconcileXPublished.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/app/ReconcileXPublished.ts tests/app/reconcileXPublished.test.ts
git commit -m "feat(reconcile): report the published texts a run can capture"
```

---

### Task 4: Write the captures, and report them

**Files:**
- Create: `src/app/CapturePublishedText.ts`
- Test: `tests/app/capturePublishedText.test.ts`
- Modify: `src/cli/x-reconcile.ts` — the preview section (alongside the other `plan.*` blocks, before the `if (!writeConfirmed)` at :196) and the write branch (the loops at :219-291, the counters above them, and the summary line at :294)

**Read first:** `src/app/RetireTranslation.ts` — this class mirrors its "only touch the columns you own" discipline and its `already-*` result shape.

**Interfaces:**
- Consumes: `ReconcilePlan.captures` from Task 3.
- Produces:
  ```typescript
  export class CapturePublishedText {
    constructor(translationStore: TranslationStore);
    run(input: { itemId: string; text: string }): Promise<"captured" | "already-present">;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/app/capturePublishedText.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CapturePublishedText } from "../../src/app/CapturePublishedText";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";

function store(seed: Translation[]) {
  const rows = [...seed];
  const s: TranslationStore = {
    loadAll: async () => rows,
    upsert: async (t) => {
      const i = rows.findIndex((r) => r.itemId === t.itemId);
      if (i >= 0) rows[i] = t; else rows.push(t);
    },
    listTranslatedIds: async () => new Set(rows.map((r) => r.itemId)),
  };
  return { rows, s };
}

const settled = (over: Partial<Translation> = {}): Translation => ({
  itemId: "x:1", source: "x", sourceText: "en", koreanText: "우리 초안",
  status: "posted", translatedAt: "2026-08-01T00:00:00.000Z",
  postedUrl: "https://x.com/0xMantleKR/status/999", postedAt: "2026-08-02T00:00:00.000Z", ...over,
});

describe("CapturePublishedText", () => {
  it("writes the published text and reports it as captured", async () => {
    const { rows, s } = store([settled()]);
    const result = await new CapturePublishedText(s).run({ itemId: "x:1", text: "올라간 글" });
    expect(result).toBe("captured");
    expect(rows[0].publishedText).toBe("올라간 글");
  });

  it("leaves every other field on the row untouched", async () => {
    // The whole-row upsert means a fresh object here would drop status/postedUrl/postedAt.
    const { rows, s } = store([settled({ approvedAt: "2026-08-01T12:00:00.000Z", refUrl: "https://x.com/a/status/1" })]);
    await new CapturePublishedText(s).run({ itemId: "x:1", text: "올라간 글" });
    expect(rows[0]).toMatchObject({
      status: "posted",
      koreanText: "우리 초안",
      postedUrl: "https://x.com/0xMantleKR/status/999",
      postedAt: "2026-08-02T00:00:00.000Z",
      approvedAt: "2026-08-01T12:00:00.000Z",
      refUrl: "https://x.com/a/status/1",
    });
  });

  it("does not overwrite a value that is already there", async () => {
    const { rows, s } = store([settled({ publishedText: "이미 있음" })]);
    const result = await new CapturePublishedText(s).run({ itemId: "x:1", text: "다른 글" });
    expect(result).toBe("already-present");
    expect(rows[0].publishedText).toBe("이미 있음");
  });

  it("writes nothing at all when the value is already there", async () => {
    // Not just "the value is unchanged" — no upsert may be issued, or a concurrent edit is clobbered.
    let upserts = 0;
    const { s } = store([settled({ publishedText: "이미 있음" })]);
    const counting: TranslationStore = { ...s, upsert: async (t) => { upserts++; await s.upsert(t); } };
    await new CapturePublishedText(counting).run({ itemId: "x:1", text: "다른 글" });
    expect(upserts).toBe(0);
  });

  it("throws for an itemId that has no row", async () => {
    const { s } = store([]);
    await expect(new CapturePublishedText(s).run({ itemId: "x:missing", text: "올라간 글" }))
      .rejects.toThrow(/x:missing/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run tests/app/capturePublishedText.test.ts`
Expected: all 5 fail — the module does not exist.

- [ ] **Step 3: Implement the use case**

Invariants:
- Reads the row, spreads `existing`, sets only `publishedText`. Every other field comes from the row just read — same discipline and same reason as `RetireTranslation.run` (`src/app/RetireTranslation.ts:131-137`).
- Returns `"already-present"` **without calling `upsert`** when the stored value is a non-empty string.
- Throws for a missing row, with the itemId in the message — the plan was built from the same store, so a missing row means a stale plan and is worth failing loudly on. Mirror `RetireTranslation`'s wording.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run tests/app/capturePublishedText.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire the CLI**

Invariants for `src/cli/x-reconcile.ts`:
- **Preview:** a `captures (n)` block listing `itemId → post rootId`, printed alongside the other plan sections. The `preview only — nothing was written` line at :198 must include the capture count, or a preview understates what `--yes` will do.
- **Write:** a loop over `plan.captures` after the existing `plan.posted` loop, using `CapturePublishedText`. Count `captured` and `alreadyPresent` separately and print a line per item, exactly as the retire loop does.
- **Failure:** a throw from `run` is caught per item, printed, and folded into the existing `failed` counter — so the run's exit code goes non-zero and the systemd `OnFailure=` hook fires. It must **not** abort the loop: one bad row must not stop the rest from being captured.
- Extend the summary line at :294 with the two new counters.
- No new Telegram notification. `retireNotification` stays exactly as it is — a capture is bookkeeping, not something an operator needs pushed to them.

- [ ] **Step 6: Verify the CLI against production, read-only**

Run: `set -a && . ~/.herald/prod.env && set +a && pnpm x:reconcile`
Expected: a `captures (n)` block naming real items, and the preview footer counting them. **Do not pass `--yes` in this step** — the write is verified in Step 7 by the operator.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
pnpm vitest run && pnpm typecheck
git add src/app/CapturePublishedText.ts tests/app/capturePublishedText.test.ts src/cli/x-reconcile.ts
git commit -m "feat(reconcile): capture the published text into the translation row"
```

---

### Task 5: Read the glossary against what was actually published

**Files:**
- Modify: `src/domain/translation/glossaryCompliance.ts` (add one exported function beside `checkGlossary`, reusing `occursAsProse` and `acceptable`)
- Modify: `src/cli/translate-check.ts` (a `--published` flag, and the new override report)
- Test: `tests/domain/glossaryCompliance.test.ts`

**Interfaces:**
- Consumes: `Translation.publishedText` from Task 1.
- Produces:
  ```typescript
  export interface GlossaryOverride { itemId: string; term: string; expected: string }
  export function checkPublishedOverrides(
    t: { itemId: string; sourceText: string; koreanText: string; publishedText?: string },
    glossary: GlossaryEntry[],
  ): GlossaryOverride[]
  ```

- [ ] **Step 1: Write the failing test**

Append to `tests/domain/glossaryCompliance.test.ts` (reuse the file's existing glossary fixture shape):

```typescript
describe("checkPublishedOverrides", () => {
  const glossary = [{ term: "narrative", rule: "translate" as const, target: "내러티브", updatedAt: "2026-07-14" }];

  it("reports a decided term our draft used and the published post dropped", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
      publishedText: "이야기가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([{ itemId: "x:1", term: "narrative", expected: "내러티브" }]);
  });

  it("reports nothing when the published post kept the decided term", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
      publishedText: "내러티브가 달라지고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when our draft never used the decided term either", () => {
    // That is a plain drift, which checkGlossary already reports. Reporting it here too would
    // double-count it and make the override list untrustworthy as a signal about the glossary.
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "이야기가 바뀌고 있습니다",
      publishedText: "이야기가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when the term never occurs as prose in the source", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "ask @narrative_xyz about it",
      koreanText: "내러티브",
      publishedText: "이야기",
    }, glossary);
    expect(out).toEqual([]);
  });

  it("reports nothing when there is no published text yet", () => {
    const out = checkPublishedOverrides({
      itemId: "x:1",
      sourceText: "the narrative is shifting",
      koreanText: "내러티브가 바뀌고 있습니다",
    }, glossary);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm vitest run tests/domain/glossaryCompliance.test.ts`
Expected: all 5 fail — `checkPublishedOverrides` is not exported.

- [ ] **Step 3: Implement the domain function**

Invariants:
- Returns `[]` immediately when `publishedText` is `undefined` or `""`.
- A term is reported only when **all three** hold: it occurs as prose in the source (`occursAsProse` — do not reimplement the handle/word-boundary filters), an `acceptable(expected)` form is present in `koreanText`, and none is present in `publishedText`.
- Same `keep`-rule handling as `checkGlossary`: `expected` is the term itself for a `keep` entry.
- Reuses `acceptable` for both sides, so a glossary note that permits `RWA` alone does not produce a phantom override.

- [ ] **Step 4: Run the test and watch it pass**

Run: `pnpm vitest run tests/domain/glossaryCompliance.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Wire the CLI**

Invariants for `src/cli/translate-check.ts`:
- `--published` switches `checkGlossary`'s target from `koreanText` to `publishedText`, and **excludes rows that have none** — a row with no published text is not a passing row, and counting it as one is exactly the vacuous-pass failure the empty-glossary refusal at :44-51 exists to prevent. Print how many rows were skipped for having no published text.
- The override report runs **always**, not only under `--published` — it is the reason this command becomes worth rerunning, and it costs one pass over rows that already carry a published text.
- The empty-glossary refusal, the first-line database banner, and the never-exit-non-zero-on-a-finding rule all stay exactly as they are.
- Update the command's doc comment: it now answers two questions, and the second one (which decided terms the humans keep overriding) is a statement about the glossary, not about a translation.

- [ ] **Step 6: Verify against production, read-only**

Run: `set -a && . ~/.herald/prod.env && set +a && pnpm translate:check --published`
Expected: a real report. With Task 4 not yet run with `--yes`, the "skipped for having no published text" count will be every row — that is correct output, not a failure.

- [ ] **Step 7: Full suite, typecheck, commit**

```bash
pnpm vitest run && pnpm typecheck
git add src/domain/translation/glossaryCompliance.ts src/cli/translate-check.ts tests/domain/glossaryCompliance.test.ts
git commit -m "feat(translate): check the glossary against the published copy, and report overrides"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/ko/capabilities.md` (the capability table row for X 발행 재확인, and the 번역 메모리 section)
- Modify: `docs/ko/artifacts.md` (the `translate:check` and `x:reconcile` rows)
- Modify: `docs/ko/team-runbook.md` (§6, the x:reconcile section)

- [ ] **Step 1: Update the Korean docs**

Invariants:
- Korean, matching the surrounding voice. These are the team's docs, not developer docs.
- Say what an operator can now *do*: `x:reconcile` also records the copy that actually went out, and `translate:check --published` reads the glossary against it.
- Say what the override report means in one sentence: a term the humans keep replacing is a sign the glossary entry is wrong, not the translation.
- Do not document the schema column. Operators do not read the database directly.
- `pnpm db:migrate` belongs in the runbook's deploy note, not in the capability description.

- [ ] **Step 2: Commit**

```bash
git add docs/ko/capabilities.md docs/ko/artifacts.md docs/ko/team-runbook.md
git commit -m "docs(ko): describe published-copy capture and the override report"
```

---

## Deploy note (operator, not agent)

After Task 1 is merged, and **before** the next `herald-x-reconcile.timer` fire:

```bash
set -a && . ~/.herald/prod.env && set +a && pnpm db:migrate
```

`translations` gains `published_text`. Skipping it makes every reconcile tick fail on an unknown column until it is run.

## Self-review

**Spec coverage.** Schema → Task 1. Capture rule (fill-only, pool-bounded, raw) → Tasks 2 and 3. Backfill of settled rows → Task 3's second test, the `retire: false` regression guard. Writing and reporting → Task 4. `--published` glossary check → Task 5. Override report → Task 5. Error handling as counted-not-thrown → Task 4 Step 5. Testing list → distributed across Tasks 2-5, all present. Out-of-scope items (TM promotion, reverse direction, confirmed route) have no tasks, as intended.

**Placeholders.** None. Every test step carries runnable code; every implementation step carries invariants plus the exact file and line range to read.

**Type consistency.** `publishedText` is the field name in every task. `PublishedTextCapture { itemId, rootId, text }` is produced in Task 2, consumed unchanged in Tasks 3 and 4. `CapturePublishedText.run` returns `"captured" | "already-present"` in both its own tests and the CLI wiring. `checkPublishedOverrides` returns `GlossaryOverride[]` in both Task 5 steps.
