# Typefully Live-Send Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Typefully X sends actually publish — fix the media-upload signature error and route publishing through Typefully's URL-safe scheduled path.

**Architecture:** Two adapter fixes. (1) `TypefullyMedia`'s S3 PUT drops the `Content-Type` header the presigned URL wasn't signed with. (2) Both senders publish via a near-future `publish_at` (a shared `scheduledPublishAt` helper) instead of `"now"`, return the draft's `share_url`, and drop the published-url poll (a scheduled draft has no published url yet).

**Tech Stack:** Hexagonal TypeScript (domain/ports/adapters/app/cli), ESM, native fetch, vitest. Chat/UI copy Korean; code + comments English.

## Global Constraints

- The media S3 PUT sends **no `Content-Type` header** (the presigned signature does not include it; adding one causes `SignatureDoesNotMatch`).
- Both senders set `publish_at` to a **future ISO timestamp** (`now + PUBLISH_DELAY_MS`, `PUBLISH_DELAY_MS = 2*60*1000`), never `"now"`, and return `{ postId: <draft id>, url: <share_url> }`. No published-url poll (a scheduled draft is never published within a poll window).
- Add an injectable `now: () => number = () => Date.now()` as the **last** ctor param of each sender so `publish_at` is deterministic in tests. The CLIs keep using the default (no CLI change).
- Telegram and all non-Typefully paths are untouched.
- After every task: `pnpm test` green and `pnpm exec tsc --noEmit` clean.

---

### Task 1: `TypefullyMedia` — drop the S3 `Content-Type` header

**Files:**
- Modify: `src/adapters/send/TypefullyMedia.ts:22,33`
- Test: `tests/adapters/send/typefullyMedia.test.ts`

**Interfaces:**
- Produces: no signature change — `upload(url)` behavior fixed (the S3 PUT no longer sends `Content-Type`).

- [ ] **Step 1: Update the test to assert no `Content-Type` on the PUT**

In `tests/adapters/send/typefullyMedia.test.ts`, capture headers in `routingFetch` and assert them. Change the `calls` push (line 10) to include headers:
```ts
    calls.push({ url: u, method, isBinary, headers: init?.headers });
```
and add an assertion at the end of the first test (`downloads, uploads to presigned S3, …`):
```ts
    const put = calls.find((c) => c.url === "https://s3.example/put")!;
    expect((put as any).headers?.["Content-Type"]).toBeUndefined();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/send/typefullyMedia.test.ts`
Expected: FAIL — the PUT currently sends `{ "Content-Type": contentType }`, so `put.headers["Content-Type"]` is defined.

- [ ] **Step 3: Implement**

In `src/adapters/send/TypefullyMedia.ts`:
- Delete the now-unused `contentType` local (line 22: `const contentType = dl.headers.get("content-type") ?? "image/jpeg";`).
- Change the PUT (line 33) to send no headers:
```ts
    const put = await this.fetchFn(upload_url, { method: "PUT", body: bytes });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/adapters/send/typefullyMedia.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/TypefullyMedia.ts tests/adapters/send/typefullyMedia.test.ts
git commit -m "fix(typefully): drop Content-Type on the presigned S3 PUT (SignatureDoesNotMatch)"
```

---

### Task 2: Scheduled-publish helper + `TypefullySender`

**Files:**
- Create: `src/adapters/send/typefullyPublish.ts`
- Modify: `src/adapters/send/TypefullySender.ts`
- Test: `tests/adapters/send/typefullySender.test.ts`

**Interfaces:**
- Produces: `PUBLISH_DELAY_MS: number` and `scheduledPublishAt(now: () => number): string` from `typefullyPublish.ts`. `TypefullySender` ctor gains a trailing `now: () => number = () => Date.now()`; `send` returns `{ postId: <draftId>, url: <share_url> }`.

- [ ] **Step 1: Write the failing tests**

Replace the body of `describe("TypefullySender", …)` in `tests/adapters/send/typefullySender.test.ts` — remove the two poll tests (`polls the draft …`, `returns the draft id without a url …`) and rewrite the first test; keep `throws on a non-ok create`:
```ts
import { scheduledPublishAt } from "../../../src/adapters/send/typefullyPublish";
// ...
const AT = 1_800_000_000_000; // fixed clock
const now = () => AT;

describe("TypefullySender", () => {
  it("creates a scheduled draft and returns the share_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 77, share_url: "https://typefully.com/t/abc" } }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep, now).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a", "b", "c"] });
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].auth).toBe("Bearer KEY");
    expect((calls[0].body as any).platforms.x.posts).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect((calls[0].body as any).publish_at).toBe(scheduledPublishAt(now)); // future ISO, not "now"
    expect((calls[0].body as any).publish_at).not.toBe("now");
    expect(res).toEqual({ postId: "77", url: "https://typefully.com/t/abc" });
    expect(calls).toHaveLength(1); // no published-url poll
  });

  it("throws on a non-ok create", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 401, body: { detail: "bad key" } }]);
    await expect(new TypefullySender("KEY", "42", fn, noSleep, now).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] }))
      .rejects.toThrow(/401/);
  });
});
```
Then in the `describe("TypefullySender media", …)` block, update `routingFetch`'s draft reply (its last `return`) to `{ id: 77, share_url: "https://typefully.com/t/abc" }`, pass `now` to the constructor in both tests that assert a result, and change the two `res` expectations to `{ postId: "77", url: "https://typefully.com/t/abc" }`. The call-sequence assertion (`GET download, POST upload, PUT put, GET poll, POST draft`) is unchanged (that `GET poll` is the media ready-poll, not a draft poll).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/adapters/send/typefullySender.test.ts`
Expected: FAIL — `scheduledPublishAt` is unresolved / `publish_at` is `"now"` / `res.url` is still the (absent) `x_published_url`.

- [ ] **Step 3: Create the helper**

`src/adapters/send/typefullyPublish.ts`:
```ts
/**
 * Typefully's direct publish (`publish_at:"now"`) is blocked by X for any tweet/article containing a
 * URL ("Direct publishing of X drafts containing URLs is blocked"). A near-future scheduled time
 * routes through Typefully's queue (the user's session), which allows URLs. 2 minutes is comfortably
 * "scheduled" while still going live promptly.
 */
export const PUBLISH_DELAY_MS = 2 * 60 * 1000;

export function scheduledPublishAt(now: () => number): string {
  return new Date(now() + PUBLISH_DELAY_MS).toISOString();
}
```

- [ ] **Step 4: Rework `TypefullySender`**

In `src/adapters/send/TypefullySender.ts`:
- Add `import { scheduledPublishAt } from "./typefullyPublish";`
- Delete `parseTweetId` (no longer used).
- Add the trailing ctor field:
```ts
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}
```
- Replace the `send` body from the create call onward:
```ts
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x: { enabled: true, posts } }, publish_at: scheduledPublishAt(this.now) }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; share_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
```
Remove the `POLL_ATTEMPTS`/`POLL_DELAY_MS` constants if they are now unused in this file.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run tests/adapters/send/typefullySender.test.ts && pnpm exec tsc --noEmit`
Expected: PASS; types clean (no dangling `parseTweetId`/poll constants).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/send/typefullyPublish.ts src/adapters/send/TypefullySender.ts tests/adapters/send/typefullySender.test.ts
git commit -m "fix(typefully): schedule X tweets (URL-safe) and return the share_url"
```

---

### Task 3: `TypefullyArticleSender` — same scheduled-publish rework

**Files:**
- Modify: `src/adapters/send/TypefullyArticleSender.ts`
- Test: `tests/adapters/send/typefullyArticleSender.test.ts`

**Interfaces:**
- Consumes: `scheduledPublishAt` (Task 2).
- Produces: ctor gains a trailing `now: () => number = () => Date.now()`; `send` returns `{ postId: <draftId>, url: <share_url> }` (signature otherwise unchanged).

- [ ] **Step 1: Rewrite the tests**

In `tests/adapters/send/typefullyArticleSender.test.ts` — add the helper import + fixed clock, rewrite the first two tests (drop the poll), keep the third:
```ts
import { scheduledPublishAt } from "../../../src/adapters/send/typefullyPublish";
const AT = 1_800_000_000_000;
const now = () => AT;

describe("TypefullyArticleSender", () => {
  it("posts a scheduled x_article draft (no enabled/posts) and returns the share_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, share_url: "https://typefully.com/t/art" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].url).toContain("/social-sets/42/drafts");
    expect(calls[0].body.platforms.x_article).toEqual({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].body.platforms.x_article.enabled).toBeUndefined();
    expect(calls[0].body.publish_at).toBe(scheduledPublishAt(now));
    expect(calls[0].body.publish_at).not.toBe("now");
    expect(res).toEqual({ postId: "5", url: "https://typefully.com/t/art" });
    expect(calls).toHaveLength(1); // no poll
  });

  it("omits cover_media_id when not provided", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, share_url: "https://typefully.com/t/art" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T" });
    expect("cover_media_id" in calls[0].body.platforms.x_article).toBe(false);
    expect(res).toEqual({ postId: "5", url: "https://typefully.com/t/art" });
  });

  it("throws on a create error", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { error: "bad" } }]);
    await expect(new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T" })).rejects.toThrow(/HTTP 400/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/adapters/send/typefullyArticleSender.test.ts`
Expected: FAIL — `publish_at` is `"now"`, `res.url` is the absent `x_article_published_url`.

- [ ] **Step 3: Implement**

In `src/adapters/send/TypefullyArticleSender.ts`:
- Add `import { scheduledPublishAt } from "./typefullyPublish";`
- Delete `parseArticleId` (no longer used) and the `POLL_ATTEMPTS`/`POLL_DELAY_MS` constants if unused.
- Add the trailing ctor field `private readonly now: () => number = () => Date.now(),` (after `sleep`).
- Replace the create-onward body:
```ts
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x_article }, publish_at: scheduledPublishAt(this.now) }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create x_article draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; share_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
```

- [ ] **Step 4: Run tests + full suite + typecheck**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS — the three sender test files plus every existing test; types clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/TypefullyArticleSender.ts tests/adapters/send/typefullyArticleSender.test.ts
git commit -m "fix(typefully): schedule the X Article draft (URL-safe) and return the share_url"
```

---

## Self-Review

- **Spec coverage:** media Content-Type → Task 1; scheduled publish + share_url + drop poll (tweet) → Task 2 (+ the shared helper); same for X Article → Task 3. All spec "Files touched" mapped.
- **Type consistency:** `scheduledPublishAt(now: () => number): string` used identically in Tasks 2/3; both senders' `now` default `() => Date.now()`; both return `{ postId: draftId, url: share_url }`.
- **Ordering:** 1 (media, independent) → 2 (helper + tweet sender) → 3 (article sender uses the helper). Each leaves `pnpm test` green and the branch compiling.
- **Placeholder scan:** every step carries real code or an exact command.
- **CLI note:** `now` defaults to `Date.now`, so the sender construction sites (`channelSenders.ts`, `send-x-article.ts`) need no change — verified they construct with `(apiKey, socialSetId)` and rely on defaults.

## Execution note (model tiers)

- Task 1: cheap (one-line impl + a header assertion).
- Task 2: standard (new helper + sender rework + test rewrite removing the poll).
- Task 3: standard (parallel rework + test rewrite).
