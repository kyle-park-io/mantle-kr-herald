# Review Annotations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annotate the id header in the translation worksheet and the Drive review `.md` with a reply marker `(댓글·옵셔널)` and a source link `[원문](url)`, so reviewers spot/skip reply-type items and jump to the source. Annotations are review metadata only — never in the translated body or the approved doc.

**Architecture:** One shared pure helper `replyAndLinkSuffix(isReply?, refUrl?)` composes the suffix. Two `isReply?`/`refUrl?` fields are threaded through the pipeline: `ContentItem.isReply` (set by `XContentSource`, consumed by the worksheet `assembleItemBlock`) and `Translation.isReply`/`refUrl` (set by `SaveTranslation`, consumed by `renderReview`). Additive and empty by default — items without the fields render exactly today's header.

**Tech Stack:** ESM TypeScript, `vitest`, `zod`-only runtime dep (this feature adds none), pure string composition.

## Global Constraints

- Runtime deps stay **zod-only**; pure string composition, no dependency, no network.
- The suffix is **additive and empty by default**: an item with neither field renders exactly today's header (backward-compatible). Marker `(댓글·옵셔널)` only when `isReply`; link `· [원문](url)` only when `refUrl`.
- Review metadata only: the suffix is in the **worksheet header** and **`renderReview` header** only — never in the translated body; `renderApproved` is untouched.
- Public repo: tests use synthetic ids/urls only — no real post text or tokens.
- Every test can fail: pin the exact header/suffix strings (including the leading space and the ` · ` separator).

---

## File Structure

- **Modify** `src/domain/translation/contentItem.ts` — `ContentItem` gains `isReply?: boolean`.
- **Modify** `src/domain/translation/promptAssembler.ts` — add exported `replyAndLinkSuffix`; `assembleItemBlock` appends it.
- **Modify** `src/adapters/content/XContentSource.ts` — set `isReply` from the root tweet.
- **Modify** `src/domain/translation/models.ts` — `Translation` gains `isReply?: boolean` + `refUrl?: string`.
- **Modify** `src/app/SaveTranslation.ts` — `SaveInput` gains `isReply?` + `refUrl?`; stored on the `Translation`.
- **Modify** `src/cli/translate-save.ts` — pass `isReply`/`refUrl` (pending item + saved-translation fallback).
- **Modify** `src/domain/publish/renderers.ts` — `renderReview` header uses `replyAndLinkSuffix`.
- **Test:** create `tests/domain/translation/promptAssembler.replyLink.test.ts`; extend the XContentSource test (`tests/adapters/content/xContentSource.test.ts`, create if absent), `tests/app/saveTranslation.test.ts`, and the renderReview test (`tests/domain/publish/renderers.test.ts`, create if absent).

---

## Task 1: Worksheet side — `replyAndLinkSuffix`, `ContentItem.isReply`, `assembleItemBlock`, `XContentSource`

**Files:** Modify `src/domain/translation/contentItem.ts`, `src/domain/translation/promptAssembler.ts`, `src/adapters/content/XContentSource.ts`; Test create `tests/domain/translation/promptAssembler.replyLink.test.ts`, extend/create `tests/adapters/content/xContentSource.test.ts`

**Interfaces:**
- Produces: `replyAndLinkSuffix(isReply?: boolean, refUrl?: string): string` (exported from `promptAssembler.ts`); `ContentItem.isReply?: boolean`. `assembleItemBlock` header becomes `### ${id}${kindMarker}${replyAndLinkSuffix(item.isReply, item.refUrl)}`.

- [ ] **Step 1: Write the failing tests.**

Create `tests/domain/translation/promptAssembler.replyLink.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { replyAndLinkSuffix, assembleItemBlock } from "../../../src/domain/translation/promptAssembler";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

describe("replyAndLinkSuffix", () => {
  it("is empty when neither field is present", () => {
    expect(replyAndLinkSuffix()).toBe("");
    expect(replyAndLinkSuffix(false, undefined)).toBe("");
  });
  it("adds the reply marker only", () => {
    expect(replyAndLinkSuffix(true, undefined)).toBe(" (댓글·옵셔널)");
  });
  it("adds the link only", () => {
    expect(replyAndLinkSuffix(false, "https://x.com/a/status/1")).toBe(" · [원문](https://x.com/a/status/1)");
  });
  it("adds both, marker before link", () => {
    expect(replyAndLinkSuffix(true, "https://x.com/a/status/1")).toBe(" (댓글·옵셔널) · [원문](https://x.com/a/status/1)");
  });
});

describe("assembleItemBlock header", () => {
  const base: ContentItem = { id: "x:1", source: "x", text: "hi", createdAt: "2026-07-28T00:00:00Z" };
  it("article reply with a link: kind marker, then reply, then link", () => {
    const block = assembleItemBlock({ ...base, kind: "article", isReply: true, refUrl: "https://x.com/a/status/1" });
    expect(block.split("\n")[0]).toBe("### x:1 [article] (댓글·옵셔널) · [원문](https://x.com/a/status/1)");
  });
  it("plain post with a link only", () => {
    const block = assembleItemBlock({ ...base, id: "x:2", kind: "post", refUrl: "https://x.com/a/status/2" });
    expect(block.split("\n")[0]).toBe("### x:2 · [원문](https://x.com/a/status/2)");
  });
  it("a Lark item (no fields) is unchanged", () => {
    const block = assembleItemBlock({ id: "lark:3", source: "lark", text: "hi", createdAt: "2026-07-28T00:00:00Z" });
    expect(block.split("\n")[0]).toBe("### lark:3");
  });
});
```

For `tests/adapters/content/xContentSource.test.ts` (extend if it exists, else create) — a reply root tweet yields `isReply: true`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XContentSource } from "../../../src/adapters/content/XContentSource";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "xsrc-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function writeThreads(threads: unknown): Promise<string> {
  const p = join(dir, "items.json");
  return writeFile(p, JSON.stringify(threads), "utf8").then(() => p);
}
const tweet = (o: Record<string, unknown>) => ({
  id: "100", conversationId: "100", text: "t", createdAt: "2026-07-28T00:00:00Z",
  url: "https://x.com/a/status/100", authorUserName: "a", isReply: false, isQuote: false, ...o,
});

describe("XContentSource isReply", () => {
  it("carries the root tweet's isReply and url onto the ContentItem", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [tweet({ isReply: true })] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.isReply).toBe(true);
    expect(item.refUrl).toBe("https://x.com/a/status/100");
  });
  it("is false for a non-reply root", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [tweet({ isReply: false })] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.isReply).toBe(false);
  });
});
```
If a `tests/adapters/content/xContentSource.test.ts` already exists, add the `describe("XContentSource isReply", …)` block using whatever thread/tweet fixture it already defines instead of redefining one.

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/domain/translation/promptAssembler.replyLink.test.ts tests/adapters/content/xContentSource.test.ts` → FAIL (export missing, `isReply` not on ContentItem/not set).

- [ ] **Step 3: Implement.**

`src/domain/translation/contentItem.ts` — add the field (alongside `refUrl`):
```ts
  refUrl?: string;
  /** X only. The root tweet's `isReply` — a reply is optional content a reviewer may skip. Undefined for Lark. */
  isReply?: boolean;
```

`src/domain/translation/promptAssembler.ts` — add the helper and use it in `assembleItemBlock`:
```ts
/** Review-header suffix: an optional reply marker and a source link. Empty when neither field is
 *  present, so a header without them (a Lark item, or an item predating this field) is unchanged.
 *  Shared by the worksheet header here and the review doc (`renderReview`). */
export function replyAndLinkSuffix(isReply?: boolean, refUrl?: string): string {
  let suffix = "";
  if (isReply) suffix += " (댓글·옵셔널)";
  if (refUrl) suffix += ` · [원문](${refUrl})`;
  return suffix;
}
```
In `assembleItemBlock`, change the header line:
```ts
  const marker = item.kind === "article" ? " [article]" : "";
  const lines = [`### ${item.id}${marker}${replyAndLinkSuffix(item.isReply, item.refUrl)}`, "원문:", item.text];
```

`src/adapters/content/XContentSource.ts` — set `isReply` on the pushed item (next to `refUrl: first?.url`):
```ts
        refUrl: first?.url,
        isReply: first?.isReply,
```

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run tests/domain/translation/promptAssembler.replyLink.test.ts tests/adapters/content/xContentSource.test.ts` → green. Also run any pre-existing `promptAssembler`/`XContentSource` tests: `pnpm exec vitest run tests/domain/translation/ tests/adapters/content/`. A pre-existing `assembleItemBlock` test whose item has **no** `refUrl`/`isReply` is unchanged (empty suffix); if one already sets `refUrl`, its expected header now gains ` · [원문](…)` — update that expectation (it is the new intended behavior), and note it in the report.

- [ ] **Step 5: Typecheck + commit.** `pnpm exec tsc --noEmit`; then `git add -A && git commit -m "feat(translation): reply(옵셔널) marker + source link in the worksheet header"`.

---

## Task 2: Review-doc side — `Translation.isReply/refUrl`, `SaveTranslation`, `translate:save`, `renderReview`

**Files:** Modify `src/domain/translation/models.ts`, `src/app/SaveTranslation.ts`, `src/cli/translate-save.ts`, `src/domain/publish/renderers.ts`; Test extend `tests/app/saveTranslation.test.ts`, extend/create `tests/domain/publish/renderers.test.ts`

**Interfaces:**
- Consumes: `replyAndLinkSuffix` from `../translation/promptAssembler` (Task 1).
- `Translation` gains `isReply?: boolean` + `refUrl?: string`; `SaveInput` gains the same two optional fields; `renderReview` header becomes `# ${t.itemId}${replyAndLinkSuffix(t.isReply, t.refUrl)}`.

- [ ] **Step 1: Write the failing tests.**

Extend `tests/app/saveTranslation.test.ts` (reuse its existing store stub / fixtures) — a save with the fields stores them:
```ts
  it("stores isReply and refUrl on the translation when provided", async () => {
    const stored: Translation[] = [];
    const store = { /* reuse the file's stub shape */ upsert: async (t: Translation) => { stored.push(t); },
      loadAll: async () => stored, listTranslatedIds: async () => new Set<string>() } as unknown as TranslationStore;
    await new SaveTranslation(store, fewShotStub).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕",
      approve: false, isReply: true, refUrl: "https://x.com/a/status/1",
    });
    expect(stored[0].isReply).toBe(true);
    expect(stored[0].refUrl).toBe("https://x.com/a/status/1");
  });
```
(Match the file's actual stub construction for `store`/`fewShotStub`; the assertion is the point — the saved `Translation` carries both fields.)

Extend/create `tests/domain/publish/renderers.test.ts` — `renderReview` header:
```ts
import { describe, it, expect } from "vitest";
import { renderReview } from "../../../src/domain/publish/renderers";
import type { Translation } from "../../../src/domain/translation/models";

const t = (o: Partial<Translation>): Translation => ({
  itemId: "x:1", source: "x", sourceText: "src", koreanText: "번역", status: "translated",
  translatedAt: "2026-07-28T00:00:00Z", ...o,
});

describe("renderReview header annotation", () => {
  it("adds reply marker + link when present", () => {
    const doc = renderReview(t({ isReply: true, refUrl: "https://x.com/a/status/1" }));
    expect(doc.split("\n")[0]).toBe("# x:1 (댓글·옵셔널) · [원문](https://x.com/a/status/1)");
    expect(doc).toContain("## 원문 (source)\n\nsrc");   // body unchanged
  });
  it("is today's header when neither field is present", () => {
    expect(renderReview(t({})).split("\n")[0]).toBe("# x:1");
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/app/saveTranslation.test.ts tests/domain/publish/renderers.test.ts` → FAIL (fields not stored / header has no suffix).

- [ ] **Step 3: Implement.**

`src/domain/translation/models.ts` — `Translation` gains (after `approvedAt?`):
```ts
  approvedAt?: string;
  isReply?: boolean;
  refUrl?: string;
```

`src/app/SaveTranslation.ts` — `SaveInput` gains the fields, and they are copied onto the stored `Translation`:
```ts
export interface SaveInput {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  approve: boolean;
  isReply?: boolean;
  refUrl?: string;
}
```
In `run`, add to the `translation` object literal:
```ts
      approvedAt: input.approve ? timestamp : undefined,
      isReply: input.isReply,
      refUrl: input.refUrl,
```

`src/domain/publish/renderers.ts` — import the helper and use it in `renderReview`:
```ts
import { replyAndLinkSuffix } from "../translation/promptAssembler";
```
```ts
export function renderReview(t: Translation): string {
  return `# ${t.itemId}${replyAndLinkSuffix(t.isReply, t.refUrl)}\n\n## 원문 (source)\n\n${t.sourceText}\n\n## 한글 (Korean)\n\n${t.koreanText}\n`;
}
```

`src/cli/translate-save.ts` — carry the fields through both the pending path and the saved-translation fallback:
- In the fallback reconstruction, add the fields:
```ts
    item = { id: saved.itemId, source: saved.source, text: saved.sourceText, createdAt: saved.translatedAt, refUrl: saved.refUrl, isReply: saved.isReply };
```
- In the `usecase.run({ … })` call, pass them from `item`:
```ts
  const res = await usecase.run({
    itemId: item.id,
    source: item.source,
    sourceText: item.text,
    koreanText,
    approve,
    isReply: item.isReply,
    refUrl: item.refUrl,
  });
```

- [ ] **Step 4: Run to verify pass, AND pre-existing renderReview/SaveTranslation tests still pass** — `pnpm exec vitest run tests/app/saveTranslation.test.ts tests/domain/publish/renderers.test.ts`. A pre-existing `renderReview` test with a `Translation` lacking the fields is unchanged (empty suffix). If one exists and now differs, it means the fixture set the fields — reconcile to the intended new header.

- [ ] **Step 5: Typecheck + full suite + commit.** `pnpm exec tsc --noEmit`; `pnpm test`; then `git add -A && git commit -m "feat(publish): reply(옵셔널) marker + source link in review docs"`.

---

## Self-Review

**1. Spec coverage:** Decision 1 (shared `replyAndLinkSuffix`, exact format, marker-only-when-isReply, link-only-when-refUrl, backward-compatible) → Task 1 helper + tests; used by the worksheet (Task 1) and `renderReview` (Task 2). Decision 2 (thread two fields) → `ContentItem.isReply` + `XContentSource` (Task 1), `Translation.isReply/refUrl` + `SaveTranslation` + `translate:save` (Task 2). Decision 3 (review metadata only, forward-looking) → suffix only in the two headers; `renderApproved` untouched; no backfill step. Testing section → both tasks. Non-goals (no article marker in review doc, no align/convert sheets, no body/approved mutation, no backfill) → nothing in the plan touches them.

**2. Placeholder scan:** No TBD/TODO; every code and test step is concrete.

**3. Type consistency:** `replyAndLinkSuffix(isReply?: boolean, refUrl?: string): string` (Task 1) is imported and called in `renderReview` (Task 2) and `assembleItemBlock` (Task 1) with the same argument order. `ContentItem.isReply?` (Task 1) is read by `assembleItemBlock` (Task 1) and set by `XContentSource` (Task 1); it is passed into `SaveInput.isReply?` via `translate:save` (Task 2). `Translation.isReply?/refUrl?` (Task 2) are written by `SaveTranslation` (Task 2) and read by `renderReview` (Task 2). `SaveInput` is the actual interface name in `src/app/SaveTranslation.ts` (not `SaveTranslationInput`).
