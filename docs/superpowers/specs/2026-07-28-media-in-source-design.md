# Media in source: surface post photos/videos in the pipeline (send from reviewed text) — Design

**Date:** 2026-07-28
**Branch:** `feat/media-in-source` (off `main`)
**Status:** approved for planning
**Supersedes the send-side of:** photo media attachment (PR #72) — its send-time `items.json`
derivation (`xPhotos` / `photosFor`) is replaced by reading media from the reviewed rendering text.

## Motivation

A post's photos/videos are invisible during 번역/검수. PR #72 attaches a post's photos at **send
time**, derived from `items.json` (`xPhotos`), so the reviewer never sees or controls which media a
post carries — it only appears on the final tweet. Kyle: "이렇게 하면 번역 때 이미지·영상 처리
어떻게 되는지를 볼 수가 없잖아."

The article path already does it right: `renderArticle` surfaces inline images as `![](url)` **in the
source text**, and `SendXArticle` (#73) reads them back from the (reviewed) translation. This design
makes **ordinary posts work the same way** — media surfaced in the source, visible + editable through
the whole pipeline, and delivered from the reviewed text. Media's single source of truth becomes the
**reviewed text**, not `items.json`.

**Scope (this cycle):** photos end-to-end (surface + send); video **visibility only** (a `[영상]`
marker that shows in the pipeline but is not uploaded). Video **capture** (mp4) + **upload**
(Typefully/Telegram) is a deliberate fast-follow — it needs a collect-schema change (re-collection)
and Typefully video-support verification, which this cycle isolates out.

## Media markers (canonical vocabulary)

Media travels through the pipeline as text markers, each **alone on its own line**:

- **Photo:** `![](url)` — the same empty-alt form `renderArticle` already emits. Survives the §6
  emitters intact: `MD_LINK` = `/\[([^\]]+)\]\(…\)/` requires ≥1 char inside the brackets, so an
  empty `[]` is never rewritten by `linksToPlain`.
- **Video:** `[영상]` — a **paren-free** marker (no url this cycle). Paren-free so `MD_LINK` never
  matches it: a `[영상](url)` form would be mangled by `linksToPlain` into `영상 (url)` before the
  send could parse it. The fast-follow carries the mp4 as `[영상] <url>` (a **bare** url after the
  marker — also `MD_LINK`-safe).

Both survive `toCanonical` (stored verbatim in `rendering.text`) and the emitters (verified against
the current `canonical.ts` regexes).

## Design

### 1. Surface post media in the source (`XContentSource`)

`renderTweetText` (non-article branch) appends each tweet's `media` after the tweet text, one marker
per line:

- `media.type === "photo"` → `![](url)`
- `media.type === "video" | "animated_gif"` → `[영상]`

Article tweets are unchanged (their body images already surface via `renderArticle`; the article
tweet's own `media` is empty). **No collect-schema change**: photo urls + the video's thumbnail
already sit in `items.json`, and the `[영상]` marker needs no url. **No re-collection** — a
`translate:prepare` re-run picks up the markers.

### 2. Marker seam (`src/domain/media/sourceMedia.ts`, new, pure)

```ts
export const PHOTO_MARKER: RegExp;   // per line: !\[\]\((url)\)
export const VIDEO_MARKER: RegExp;   // per line: \[영상\](?:\s+(url))?
export function extractMedia(text: string): { text: string; photos: string[]; videos: string[] };
export function stripMedia(text: string): string;   // === extractMedia(text).text
```

`extractMedia` removes each marker line (collapsing the surrounding blank line it would leave) and
returns the cleaned text plus the photo urls and video urls. `videos` has one entry per `[영상]`
marker — the captured url, or `""` when the marker has none (this cycle: always `""`, so
`videos.length` = the video count). Pure, unit-tested.

### 3. Emit strips markers (length + delivered segments are marker-free)

The §6 emit dispatcher (`src/domain/formatting/emitters/index.ts` — `emit` and `emitAll`) runs
`stripMedia` on the canonical text **before** per-destination emission. This keeps `rendering.text`
(the stored canonical, with markers, review-visible) intact while ensuring a marker **never** counts
toward length or reaches a destination: a ~55-char `![](url)` must not push a 280-char tweet
false-over-limit in the format warnings (`FormatVariants` → `emitAll`), the refinement worksheet
(`refinementWorksheet` → `emit`), or the send over-limit guard (`SendChannels` → `emit`) — all three
route through this one seam. `send:x-article` (#73) does not use `emit`, so it is unaffected.

### 4. Send reads media from the reviewed text (`SendChannels`)

Replace the `photosFor(itemId)` (items.json) dependency with reading media from `r.text`:

```
const { photos, videos } = extractMedia(r.text);
const emitResult = emit(r.text, DELIVERY_DESTINATION[r.channel]); // emit strips markers → clean segments + correct length
...
const res = await sender.send({ itemId, type, channel, segments, photos });
if (videos.length) console.warn(`[send] ${key}: ${videos.length} video(s) present, not attached this cycle`);
```

Photo upload/attach in the senders (`TypefullySender`, `TelegramBotSender`) is **unchanged** — they
still receive `SendRequest.photos`. Remove the `photosFor` constructor param from `SendChannels`.

### 5. Removals

- Delete `src/adapters/content/xMediaLookup.ts` (`xPhotos`) + its test — the items.json derivation
  is superseded. `xArticleMeta` (the article cover lookup) is a separate concern and **stays**.
- Drop the `xPhotos(paths.xItems)` wiring in `src/cli/send-channels.ts` (last `SendChannels` arg).

## Non-goals (this cycle)

- Video **capture** (`video_info.variants` mp4 in the collect schema) and **upload** (Typefully
  video, Telegram `sendVideo`, size limits) — the fast-follow.
- The article path (`SendXArticle` #73) and its items.json cover lookup (`xArticleMeta`) — unchanged.
  Unifying the article cover into the source text is out of scope.
- Editing which media a rendering carries beyond deleting a marker line (a reviewer can already delete
  a marker line to drop that media; adding a new arbitrary image is out of scope).

## Testing

- `sourceMedia` (pure): one photo → extracted + stripped; multiple photos; `[영상]` → one video entry
  (`""`) + stripped; mixed photo+video; no markers → text unchanged; blank-line cleanup around a
  removed marker line.
- `XContentSource` (fixture): a post with a photo surfaces `![](url)`; a post with a video surfaces
  `[영상]`; an article tweet is unchanged; a text-only post is unchanged.
- `emit` / `emitAll` (canonical with a `![](url)` line): emitted segments contain no marker; a tweet
  that fits once the marker is stripped is **not** flagged over-limit (guards the length regression).
- `SendChannels` (fakes): photos come from `r.text` (not items.json); outgoing segments are
  marker-free; a `[영상]`-only rendering sends text with no photos and warns. The existing #72
  photo-attach assertions move from `photosFor` to text-sourced photos.
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, manual)

Re-run the E2E: `translate:prepare` the keepers (now surfaces markers) → re-translate (keep markers)
→ convert → format (markers visible in the refinement worksheet / dashboard) → `send:channels
--target x,telegram` (photos attached from the reviewed text; the video post shows `[영상]` in review,
its tweet goes out text-only) + `send:x-article`. Confirm the reviewer sees each post's media in the
worksheet/dashboard before approving.

## Files touched

- **Create:** `src/domain/media/sourceMedia.ts` (+ test)
- **Modify:** `src/adapters/content/XContentSource.ts` (surface markers),
  `src/domain/formatting/emitters/index.ts` (`emit`/`emitAll` strip markers),
  `src/app/SendChannels.ts` (`extractMedia`, drop `photosFor`),
  `src/cli/send-channels.ts` (drop `xPhotos` wiring)
- **Delete:** `src/adapters/content/xMediaLookup.ts` + its test
- **Tests:** `XContentSource`, `SendChannels` (#72 photo assertions → text-sourced), `emit`/`emitAll`
  length+strip, `sourceMedia`
