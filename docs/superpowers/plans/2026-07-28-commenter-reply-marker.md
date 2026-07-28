# Commenter-reply Inline Marker + Review Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefix thread-internal commenter-reply tweets (a reply Mantle made to someone else's comment, bundled into a thread) with an inline `(댓글 · 지워도 됨)` marker so a reviewer knows that segment is deletable; and add one blank line between the 원문 and 한글 sections of the review `.md`.

**Architecture:** `XContentSource.loadPending` injects the marker into `ContentItem.text` at join time (so it flows to both the worksheet 원문 and the review `.md` 원문 with no renderer change); `renderReview` gets one extra `\n`. Both are pure string composition. Follows PR #66's item-level header marker, which only covers items whose root is a reply.

**Tech Stack:** ESM TypeScript, `vitest`, `zod`-only runtime dep (adds none).

## Global Constraints

- Runtime deps stay **zod-only**; pure string composition, no dependency, no network.
- **Additive:** a thread with no commenter-replies renders exactly today's `text`; the review-doc blank line is the only format change and does not alter content.
- The marker targets **`index > 0 && isReply && text.trimStart().startsWith("@")`** — a non-root reply that leads with an `@mention`. A self-thread continuation (`isReply` but no leading `@`, e.g. "Come Saturday…") and the root tweet (index 0) are **not** marked.
- Marker text is exactly `(댓글 · 지워도 됨)` (U+00B7 middle dot, single spaces). Review metadata only — 원문 source, never the 한글 or approved doc.
- Public repo: synthetic handles/text only. Pin the exact marked string and the review-doc spacing.

---

## File Structure

- **Modify** `src/adapters/content/XContentSource.ts` — `COMMENTER_REPLY_MARKER` + `isCommenterReply` + the join `.map` gains the index and prefixes the marker.
- **Modify** `src/domain/publish/renderers.ts` — `renderReview` adds one `\n` between `sourceText` and `## 한글 (Korean)`.
- **Test:** extend `tests/adapters/content/xContentSource.test.ts` (reuse its `tweet`/`writeThreads` helpers) and `tests/domain/publish/renderers.test.ts`.

---

## Task 1: Commenter-reply inline marker + review-doc blank line

**Files:** Modify `src/adapters/content/XContentSource.ts`, `src/domain/publish/renderers.ts`; Test extend `tests/adapters/content/xContentSource.test.ts`, `tests/domain/publish/renderers.test.ts`

**Interfaces:**
- Produces: `COMMENTER_REPLY_MARKER = "(댓글 · 지워도 됨)"` (exported from `XContentSource.ts`). `ContentItem.text` for an X thread now prefixes non-root commenter-reply tweets with the marker. `renderReview`'s 원문↔한글 gap is `\n\n\n`.

- [ ] **Step 1: Write the failing tests.**

Add to `tests/adapters/content/xContentSource.test.ts` (reuse the file's existing `tweet(...)` and `writeThreads(...)` helpers; `tweet` takes overrides incl. `id`, `text`, `isReply`):
```ts
  it("prefixes a nested commenter-reply (isReply + leading @), but not the root or a self-continuation", async () => {
    const path = await writeThreads([{ rootId: "100", status: "active", tweets: [
      tweet({ id: "100", text: "24/7 access to markets" }),                  // root, isReply false
      tweet({ id: "101", text: "Come Saturday, trade here", isReply: true }), // self-continuation, no @
      tweet({ id: "102", text: "@churchi 🫡", isReply: true }),                // commenter-reply
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe(
      "24/7 access to markets\n\n---\n\nCome Saturday, trade here\n\n---\n\n(댓글 · 지워도 됨) @churchi 🫡",
    );
  });

  it("does not inline-mark a root commenter-reply (index 0)", async () => {
    const path = await writeThreads([{ rootId: "200", status: "active", tweets: [
      tweet({ id: "200", text: "@someone thanks", isReply: true }),
    ] }]);
    const [item] = await new XContentSource(path).loadPending(new Set());
    expect(item.text).toBe("@someone thanks"); // unmarked; PR #66's header marker handles a standalone reply
  });
```

Add to `tests/domain/publish/renderers.test.ts`:
```ts
  it("puts one blank line between the source content and the 한글 heading", () => {
    const doc = renderReview(t({ sourceText: "src", koreanText: "번역" }));
    expect(doc).toContain("src\n\n\n## 한글 (Korean)\n\n번역");
  });
```
(reuse the file's existing `t(...)` translation-fixture helper.)

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/adapters/content/xContentSource.test.ts tests/domain/publish/renderers.test.ts` → the new cases FAIL (no marker; only `\n\n` before `## 한글`).

- [ ] **Step 3: Implement.**

`src/adapters/content/XContentSource.ts` — add the constant + predicate near the top (after the imports / `THREAD_TWEET_SEPARATOR`):
```ts
/** A reply Mantle made to someone else's comment, bundled into a thread by conversationId — its text
 *  leads with an @mention. A self-thread continuation is also `isReply` but does NOT lead with `@`, so
 *  it stays unmarked. Applied to non-root tweets only: a standalone reply item (root isReply) is already
 *  flagged by the item-level header marker (ContentItem.isReply). */
export const COMMENTER_REPLY_MARKER = "(댓글 · 지워도 됨)";

function isCommenterReply(t: SourceTweet): boolean {
  return t.isReply && t.text.trimStart().startsWith("@");
}
```
Change the join `.map` to take the index and prefix the marker:
```ts
      const text = thread.tweets
        .map((t, i) => {
          const rendered = renderTweetText(t);
          if (rendered.isArticle) hasArticle = true;
          return i > 0 && isCommenterReply(t) ? `${COMMENTER_REPLY_MARKER} ${rendered.text}` : rendered.text;
        })
        .join(THREAD_TWEET_SEPARATOR);
```
(`SourceTweet` is already imported at the top of the file.)

`src/domain/publish/renderers.ts` — add one `\n` in `renderReview` between `sourceText` and the 한글 heading:
```ts
export function renderReview(t: Translation): string {
  return `# ${t.itemId}${replyAndLinkSuffix(t.isReply, t.refUrl)}\n\n## 원문 (source)\n\n${t.sourceText}\n\n\n## 한글 (Korean)\n\n${t.koreanText}\n`;
}
```

- [ ] **Step 4: Run to verify pass, AND pre-existing tests still pass** — `pnpm exec vitest run tests/adapters/content/ tests/domain/publish/`. The new cases pass. A pre-existing `XContentSource` test whose thread has no commenter-reply is unchanged (marker only prefixes matching non-root tweets). A pre-existing `renderReview` test that pins the whole doc string with the old `\n\n## 한글` gap now differs — update that expectation to `\n\n\n## 한글` (the intended new spacing) and note it in the report.

- [ ] **Step 5: Typecheck + full suite + commit.** `pnpm exec tsc --noEmit`; `pnpm test`; then `git add -A && git commit -m "feat(content): inline commenter-reply marker + review-doc source/한글 spacing"`.

---

## Self-Review

**1. Spec coverage:** Decision 1 (inline marker on `index>0 && isReply && leading-@`, `(댓글 · 지워도 됨)`, injected in `XContentSource`, root/self-continuation excluded) → Task 1 XContentSource change + the two adapter tests (nested reply marked; root reply + self-continuation unmarked). Decision 2 (one blank line 원문↔한글 in `renderReview`) → Task 1 renderers change + test. Testing section → Task 1. Non-goals (no header-marker change, no drop, no 한글 marking, no re-collect) → nothing in the plan touches them.

**2. Placeholder scan:** No TBD/TODO; every code and test step is concrete with pinned strings.

**3. Type consistency:** `isCommenterReply(t: SourceTweet): boolean` uses `SourceTweet` (already imported in `XContentSource.ts`). The `.map((t, i) => …)` index is the only signature change to the existing join. `COMMENTER_REPLY_MARKER` is a string constant. `renderReview(t: Translation)` signature is unchanged — only its template string gains one `\n`. The tests reuse existing `tweet`/`writeThreads`/`t` fixtures already present in those two test files (created by the review-annotations feature, PR #66).
