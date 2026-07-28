# Media in Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a post's photos/videos as text markers in the source, visible through the whole pipeline, and deliver photos from the reviewed text instead of deriving them from `items.json` at send time.

**Architecture:** A new pure `sourceMedia` domain util defines the markers and the send-time extraction. `XContentSource` writes markers into the source (`![](url)` for photos, `[영상]` for videos). `emit` strips markers before per-destination emission (so `rendering.text` keeps them for review but the delivered text + length checks never include them). `SendChannels` reads photos from the rendering text via `extractMedia`, replacing PR #72's `xPhotos(items.json)` derivation, which is then deleted.

**Tech Stack:** Hexagonal TypeScript (domain/ports/adapters/app/cli), ESM, zod-only runtime dep, native fetch, vitest, tsx. Chat/UI copy Korean; code + comments English.

## Global Constraints

- **Marker forms are exact.** Photo: `![](url)` — **empty alt**, identical to `renderArticle`'s inline-image form. Video: `[영상]` — **paren-free** (a `[영상](url)` form is rewritten by `linksToPlain`'s `MD_LINK` and must never be used). Each marker sits **alone on its own line**.
- **`rendering.text` retains markers.** Only `emit`'s output and the sent segments are marker-free. Never strip markers from what `FormatVariants` stores or what the dashboard/worksheet shows.
- **Never collapse `\n\n\n` post boundaries.** `extractMedia` may only remove marker lines (and a single blank line each sat behind) and trim edge blank lines; interior blank-line runs — including X's `\n\n\n` post boundary — must survive byte-for-byte.
- **Video is visibility-only this cycle.** `[영상]` is surfaced and stripped-at-send but never uploaded. No collect-schema change, no `sendVideo`.
- After every task: `pnpm test` green and `pnpm exec tsc --noEmit` clean.

---

### Task 1: `sourceMedia` domain util

**Files:**
- Create: `src/domain/media/sourceMedia.ts`
- Test: `tests/domain/media/sourceMedia.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractMedia(text: string): { text: string; photos: string[]; videos: string[] }`
  - `stripMedia(text: string): string` (= `extractMedia(text).text`)

- [ ] **Step 1: Write the failing test**

`tests/domain/media/sourceMedia.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractMedia, stripMedia } from "../../../src/domain/media/sourceMedia";

describe("extractMedia", () => {
  it("extracts a photo marker and removes it with the blank line it sat behind", () => {
    expect(extractMedia("트윗 본문\n\n![](https://img/a.jpg)")).toEqual({
      text: "트윗 본문", photos: ["https://img/a.jpg"], videos: [],
    });
  });

  it("extracts multiple photos in document order", () => {
    const r = extractMedia("본문\n\n![](https://img/a.jpg)\n![](https://img/b.jpg)");
    expect(r.photos).toEqual(["https://img/a.jpg", "https://img/b.jpg"]);
    expect(r.text).toBe("본문");
  });

  it("records a video marker (empty url this cycle) and removes it", () => {
    expect(extractMedia("영상 트윗\n\n[영상]")).toEqual({ text: "영상 트윗", photos: [], videos: [""] });
  });

  it("handles a photo and a video together", () => {
    const r = extractMedia("본문\n\n![](https://img/a.jpg)\n\n[영상]");
    expect(r.photos).toEqual(["https://img/a.jpg"]);
    expect(r.videos).toEqual([""]);
    expect(r.text).toBe("본문");
  });

  it("leaves text without markers unchanged", () => {
    expect(extractMedia("그냥 텍스트")).toEqual({ text: "그냥 텍스트", photos: [], videos: [] });
  });

  it("preserves an X post boundary (\\n\\n\\n) when a photo sits on the first tweet", () => {
    const r = extractMedia("첫 트윗\n\n![](https://img/a.jpg)\n\n\n둘째 트윗");
    expect(r.photos).toEqual(["https://img/a.jpg"]);
    expect(r.text).toBe("첫 트윗\n\n\n둘째 트윗");
  });

  it("stripMedia returns just the cleaned text", () => {
    expect(stripMedia("본문\n\n![](https://x/a.jpg)")).toBe("본문");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/media/sourceMedia.test.ts`
Expected: FAIL — cannot resolve `../../../src/domain/media/sourceMedia`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/media/sourceMedia.ts`:
```ts
/**
 * Media surfaced in the source text as canonical markers, plus the send-time extraction that
 * reverses it. A post's photos/videos live in items.json, but the pipeline's single source of truth
 * is the reviewed text: XContentSource writes these markers into the source, they stay visible
 * through translation/convert/format (stored in rendering.text), and the send reads them back here.
 */

/** An empty-alt markdown image alone on its line — the exact form renderArticle emits for an
 *  article's inline images, so a photo looks identical in a post and an article. */
const PHOTO_LINE = /^!\[\]\(([^)]+)\)[ \t]*$/;
/** A video marker alone on its line: `[영상]`, optionally followed by a bare url (the follow-up puts
 *  the mp4 there; this cycle it has none). Paren-free so linksToPlain's MD_LINK never rewrites it. */
const VIDEO_LINE = /^\[영상\](?:[ \t]+(\S+))?[ \t]*$/;

export interface ExtractedMedia {
  /** The text with every marker line removed (and the blank line each one sat behind). */
  text: string;
  /** Photo urls, in document order. */
  photos: string[];
  /** One entry per `[영상]` marker — its url, or "" when it has none (this cycle: always ""). */
  videos: string[];
}

export function extractMedia(text: string): ExtractedMedia {
  const photos: string[] = [];
  const videos: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const photo = PHOTO_LINE.exec(line);
    if (photo) {
      photos.push(photo[1]);
      if (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop(); // drop the \n\n it sat behind
      continue;
    }
    const video = VIDEO_LINE.exec(line);
    if (video) {
      videos.push(video[1] ?? "");
      if (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  // Only edge blank lines are trimmed; interior runs (incl. X's \n\n\n post boundaries) stay as-is.
  return { text: kept.join("\n").replace(/^\n+|\n+$/g, ""), photos, videos };
}

export function stripMedia(text: string): string {
  return extractMedia(text).text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/domain/media/sourceMedia.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/media/sourceMedia.ts tests/domain/media/sourceMedia.test.ts
git commit -m "feat(media): sourceMedia — surface/extract photo & video markers"
```

---

### Task 2: `emit` strips media markers

**Files:**
- Modify: `src/domain/formatting/emitters/index.ts:31-33` (the `emit` function)
- Test: `tests/domain/formatting/emitters/index.test.ts` (add cases)

**Interfaces:**
- Consumes: `stripMedia` from Task 1; `emit(canonical, destination): EmitResult`, `EmitSegment = { text; label?; length; limit; overLimit }`.
- Produces: no signature change — `emit`/`emitAll` now strip markers before per-destination emission (`emitAll` already routes through `emit`).

- [ ] **Step 1: Write the failing test**

Add to `tests/domain/formatting/emitters/index.test.ts`:
```ts
import { emit } from "../../../../src/domain/formatting/emitters";

describe("emit strips media markers", () => {
  it("removes a photo marker from the delivered text", () => {
    const joined = emit("맨틀 소식\n\n![](https://img/a.jpg)", "telegram_bot").segments.map((s) => s.text).join("");
    expect(joined).toContain("맨틀 소식");
    expect(joined).not.toContain("![](");
  });

  it("does not count a stripped photo marker toward the length limit", () => {
    const body = "가".repeat(270); // ~270 weighted, under X's 280
    const withMarker = `${body}\n\n![](https://pbs.twimg.com/media/HOO5ibObIAArZVJ.png)`; // raw length > 280
    expect(emit(withMarker, "x_typefully").segments.some((s) => s.overLimit)).toBe(false);
  });

  it("removes a [영상] marker from the delivered text", () => {
    const joined = emit("영상 트윗\n\n[영상]", "telegram_bot").segments.map((s) => s.text).join("");
    expect(joined).toContain("영상 트윗");
    expect(joined).not.toContain("[영상]");
  });
});
```
(If `index.test.ts` has no top-level `describe`/imports you can extend, add these imports at the top; the file already tests `emit`/`emitAll`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/formatting/emitters/index.test.ts`
Expected: FAIL — delivered text still contains `![](…)` / `[영상]`; the over-limit case is `true`.

- [ ] **Step 3: Write minimal implementation**

In `src/domain/formatting/emitters/index.ts`, add the import and strip in `emit`:
```ts
import { stripMedia } from "../../media/sourceMedia";
```
```ts
export function emit(canonical: string, destination: Destination): EmitResult {
  return EMITTERS[destination](stripMedia(canonical));
}
```
(`emitAll` is unchanged — it calls `emit`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/formatting/emitters/`
Expected: PASS — the new cases plus every existing emitter test (marker-free text is unaffected: `stripMedia` is identity on it).

- [ ] **Step 5: Commit**

```bash
git add src/domain/formatting/emitters/index.ts tests/domain/formatting/emitters/index.test.ts
git commit -m "feat(format): emit strips media markers (rendering.text keeps them, delivery + length do not)"
```

---

### Task 3: `XContentSource` surfaces post media

**Files:**
- Modify: `src/adapters/content/XContentSource.ts` (add `mediaMarkers`; append in `renderTweetText`'s non-article branch)
- Test: `tests/adapters/content/xContentSource.test.ts` (add a `describe`)

**Interfaces:**
- Consumes: `SourceTweet.media?: MediaItem[]` where `MediaItem = { type: "photo" | "video" | "animated_gif"; url: string }`.
- Produces: for a non-article tweet, `ContentItem.text` = the tweet text followed by `\n\n` + one marker line per media item. Article tweets unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/content/xContentSource.test.ts`:
```ts
describe("XContentSource media markers", () => {
  it("surfaces a post's photo as an empty-alt image marker after the text", async () => {
    const p = await writeThreads([{ rootId: "300", status: "active", tweets: [
      tweet({ id: "300", text: "본문", media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문\n\n![](https://pbs.twimg.com/media/a.jpg)");
  });

  it("surfaces a video as a paren-free [영상] marker, without the thumbnail url", async () => {
    const p = await writeThreads([{ rootId: "301", status: "active", tweets: [
      tweet({ id: "301", text: "영상 트윗", media: [{ type: "video", url: "https://pbs.twimg.com/amplify_video_thumb/x.jpg" }] }),
    ] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("영상 트윗\n\n[영상]");
    expect(item.text).not.toContain("amplify_video_thumb");
  });

  it("appends nothing to a text-only post", async () => {
    const p = await writeThreads([{ rootId: "302", status: "active", tweets: [tweet({ id: "302", text: "본문만" })] }]);
    const [item] = await new XContentSource(p).loadPending(new Set());
    expect(item.text).toBe("본문만");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/content/xContentSource.test.ts`
Expected: FAIL — the photo/video cases get `"본문"` / `"영상 트윗"` with no marker appended.

- [ ] **Step 3: Write minimal implementation**

In `src/adapters/content/XContentSource.ts`, import `MediaItem` (extend the existing `SourceTweet` import from `../../domain/models`):
```ts
import type { CollectedThread, MediaItem, SourceTweet } from "../../domain/models";
```
Add the helper above `renderTweetText`:
```ts
/** Surface a post's media as canonical markers, each on its own line, so it is visible through the
 *  pipeline and delivered from the reviewed text (see domain/media/sourceMedia). Photos use the
 *  empty-alt image form; a video/gif uses a paren-free [영상] marker (mp4 upload is a follow-up). */
function mediaMarkers(media: MediaItem[] | undefined): string {
  if (!media || media.length === 0) return "";
  const lines = media.map((m) => (m.type === "photo" ? `![](${m.url})` : "[영상]"));
  return `\n\n${lines.join("\n")}`;
}
```
In `renderTweetText`, change the non-article return:
```ts
  return { text: t.text + mediaMarkers(t.media), isArticle: false };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/adapters/content/xContentSource.test.ts`
Expected: PASS — new cases plus every existing XContentSource test.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/content/XContentSource.ts tests/adapters/content/xContentSource.test.ts
git commit -m "feat(content): surface post photos (![]()) and videos ([영상]) in the source text"
```

---

### Task 4: `SendChannels` reads media from the reviewed text; remove `xPhotos`

**Files:**
- Modify: `src/app/SendChannels.ts` (drop `photosFor` ctor param; read media from `r.text`)
- Modify: `src/cli/send-channels.ts:10,22` (drop the `xPhotos` import + wiring)
- Delete: `src/adapters/content/xMediaLookup.ts`, `tests/adapters/content/xMediaLookup.test.ts`
- Test: `tests/app/sendChannels.test.ts:142-161` (replace the two `photosFor` tests)

**Interfaces:**
- Consumes: `extractMedia` from Task 1; `emit(r.text, DELIVERY_DESTINATION[r.channel])` (Task 2, strips markers).
- Produces: `SendChannels` constructor drops its 7th arg; media now comes from the rendering text. `xPhotos` no longer exists.

- [ ] **Step 1: Update the failing tests**

Replace `tests/app/sendChannels.test.ts:142-161` (the two `photosFor` tests) with:
```ts
  it("reads photos from the rendering text and passes them to the sender", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "본문\n\n![](https://pbs.twimg.com/media/a.jpg)" })]);
    const { ledger } = fakeLedger();
    const got: { photos?: string[]; segments: string[] }[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push({ photos: req.photos, segments: req.segments }); return { postId: "1" }; } };
    await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(got[0].photos).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
    expect(got[0].segments.join("")).not.toContain("![("); // marker stripped from delivered text
    expect(got[0].segments.join("")).toContain("본문");
  });

  it("sends a marker-free rendering with photos: []", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram", text: "그냥 텍스트" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "telegram", send: async (req) => { got.push(req.photos); return { postId: "p" }; } };
    await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(got[0]).toEqual([]);
  });

  it("a [영상]-only rendering sends text-only (photos: []) and does not throw", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "영상 트윗\n\n[영상]" })]);
    const { ledger } = fakeLedger();
    const got: (string[] | undefined)[] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { got.push(req.photos); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(res.sent).toBe(1);
    expect(got[0]).toEqual([]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/app/sendChannels.test.ts`
Expected: FAIL — photos still come from the (now-absent) `photosFor`, so `got[0].photos` is `[]`, not the url from the text.

- [ ] **Step 3: Implement — read media from `r.text`**

In `src/app/SendChannels.ts`:
- Add the import: `import { extractMedia } from "../domain/media/sourceMedia";`
- Delete the `photosFor` constructor parameter (the last one) and its property.
- In `run`, replace the photos/segments block inside the `try`:
```ts
        const { photos, videos } = extractMedia(r.text);
        const segments = emitResult.segments.map((s) => s.text);
        const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments, photos });
        if (videos.length > 0) console.warn(`[send] ${key}: ${videos.length} video(s) present in the rendering, not attached this cycle`);
```
(`emitResult` is already computed above from `emit(r.text, …)` and already strips markers, so `segments` are marker-free. `extractMedia` supplies the photo urls.)

- [ ] **Step 4: Remove `xPhotos` and its wiring**

- In `src/cli/send-channels.ts`: delete the import on line 10 (`import { xPhotos } from "../adapters/content/xMediaLookup";`) and change the construction on line 22 to drop the final two args:
```ts
const result = await new SendChannels(store, senders, ledger, record, archive).run({ targets, ids });
```
- Delete `src/adapters/content/xMediaLookup.ts` and `tests/adapters/content/xMediaLookup.test.ts`.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS — `sendChannels.test.ts` green; no references to `xPhotos` remain; types clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(send): read post photos from the reviewed rendering text; remove xPhotos(items.json) derivation"
```

---

## Self-Review

- **Spec coverage:** §1 surface markers → Task 3; §2 sourceMedia seam → Task 1; §3 emit strips → Task 2; §4 send-from-text → Task 4; §5 removals (`xMediaLookup`, CLI wiring) → Task 4. Testing bullets map onto Tasks 1–4. All covered.
- **Type consistency:** `extractMedia`/`stripMedia` signatures identical across Tasks 1/2/4. `MediaItem`/`SourceTweet.media` used in Task 3 match `domain/models.ts`. `EmitSegment.text`/`.overLimit` used in Tasks 2/4 match `emitters/types.ts`. `SendChannels` 7-arg → 6-arg change is applied in both the CLI (Task 4 Step 4) and the tests (Task 4 Step 1) in the same task, so the branch compiles.
- **Ordering:** 1 (util) → 2 (emit uses util) → 3 (source produces markers; emit already strips them so nothing leaks) → 4 (send switches source of media + removes the old path). Each task leaves `pnpm test` green and the branch compiling.
- **Placeholder scan:** none — every step carries real code or an exact command.

## Execution note (model tiers for subagent-driven-development)

- Task 1: cheap (complete code in-plan, pure).
- Task 2: cheap (one-line change + tests).
- Task 3: cheap/standard (one helper + tests).
- Task 4: standard (multi-file refactor + deletion + test rewrite).
