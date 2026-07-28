# Channel delivery: photo media attachment — Design

**Date:** 2026-07-28
**Branch:** `feat/media-attach-photos` (off `main`)
**Status:** approved for planning
**Sequel:** part 2 (article → X Article, and video) reuses this media-upload flow.

## Motivation

Mantle's posts carry photos/videos, but `send:channels` delivers **text only** — the media is
dropped. Media **is** captured (`SourceTweet.media: MediaItem[]`, `{type, url}`, in `output/x/items.json`)
but never propagated past collection. This slice attaches **photos** (real `pbs.twimg.com` URLs) to the
posts we send to **X (via Typefully)** and **Telegram**. Videos (need `video_info.variants` mp4 capture)
and article inline images are out of scope here — part 2.

Typefully v2 supports media via a presigned-S3 upload flow (verified from the API docs):
1. `POST /v2/social-sets/{id}/media/upload` `{"file_name":"x.jpg"}` → `{ media_id, upload_url }`
2. `PUT <upload_url>` with the file **bytes** (presigned S3)
3. `GET /v2/social-sets/{id}/media/{media_id}` → poll `status` until `ready`
4. `POST …/drafts` with `posts:[{ text, media_ids:["<id>"] }]`

Telegram accepts a photo **URL directly** (no download needed): `sendPhoto` / `sendMediaGroup`.

## Approach

**Derive media at send time**, do not thread it through the `Translation`/`ChannelRendering` models.
A rendering carries an `itemId`; at send time we look up that source item's photos from `items.json`.
This mirrors how the dashboard derives `kind`/`postedAt`, and keeps the change to the send edge.

## Design

### Media lookup

- New port-ish function injected into `SendChannels`: `photosFor?: (itemId: string) => Promise<string[]>`
  (optional; `undefined` ⇒ no photos, fully backward-compatible).
- Adapter `src/adapters/content/xMediaLookup.ts` → `xPhotos(itemsPath): (itemId) => Promise<string[]>`:
  reads `items.json`, finds the thread whose `x:<rootId> === itemId`, returns every tweet's
  `media` entries with `type === "photo"` mapped to `url`. Article items (images are body blocks, not
  `media`) and text-only items return `[]`. Pure over an injected file read; unit-tested.

### `SendRequest` + `SendChannels`

- `SendRequest` (`src/ports/ChannelSender.ts`) gains `photos?: string[]`.
- `SendChannels` ctor gains the optional `photosFor`. In `run`, before `sender.send`, compute
  `const photos = this.photosFor ? await this.photosFor(r.itemId) : [];` and pass it:
  `sender.send({ itemId, type, channel, segments, photos })`. All idempotency/ledger/record/archive
  logic is unchanged.

### `TypefullySender` (the substantial part)

Add a private `uploadPhotos(photos: string[]): Promise<string[]>` that, per photo:
1. `download` the bytes: `fetchFn(url)` → `arrayBuffer`; capture the `Content-Type` (default `image/jpeg`).
2. `POST /v2/social-sets/{id}/media/upload` with `{ file_name }` (derived from the URL's last path
   segment, fallback `media.jpg`) → `{ media_id, upload_url }`.
3. `PUT upload_url` with the raw bytes (`Content-Type` from step 1; **no** Authorization header — it is
   a presigned S3 URL).
4. Poll `GET /v2/social-sets/{id}/media/{media_id}` (reuse the existing `POLL_ATTEMPTS`/`POLL_DELAY_MS`)
   until `status === "ready"`; throw on `failed` or timeout.
Return the collected `media_id`s.

`send()` uploads photos **first** (so a media failure throws before any draft is created — the send
stays idempotent and retries cleanly), then creates the draft with the media on the **lead post**:
`posts[0].media_ids = mediaIds` (X shows media on the first tweet of a thread). No photos ⇒ today's
exact payload.

### `TelegramBotSender`

If `req.photos?.length`:
- Send the photos as the **first** message: `sendMediaGroup` for 2–10, `sendPhoto` for 1 (photo = the
  URL). When the whole text (segments joined) is ≤ 1024 chars, pass it as the `caption` on the (first)
  photo and skip re-sending it; otherwise send the photos caption-less, then the text segments as
  today (reply-chained to the media message). `firstId`/url reporting unchanged.
- `> 10` photos: send the first 10 (Telegram's media-group cap); a post with >10 photos is not a real case.

No photos ⇒ today's exact behavior.

### CLI wiring

`src/cli/send-channels.ts` builds `photosFor = xPhotos(paths.xItems)` and passes it to `SendChannels`.

## Non-goals

- **Video** (needs `video_info.variants` mp4 capture — schema change) — later.
- **Article inline images** (article images are `ArticleBody` blocks, already rendered `![](url)` in
  text; posting them as X Article media is part 2).
- Kakao / pr_mail media; editing or removing already-sent media; per-thread-segment media distribution
  (all media rides the lead post).

## Testing

- `xPhotos`: an item with photos → their urls (order preserved); video/no-media/article item → `[]`;
  unknown itemId → `[]`; multiple tweets in a thread → concatenated. (Injected `readFile`/fixture.)
- `TypefullySender` (fake `fetch`): the upload sequence (upload→PUT→poll-ready) yields `media_ids`, and
  the draft body's `posts[0].media_ids` carries them; a media-upload HTTP error throws **before** any
  draft POST; no photos ⇒ payload has no `media_ids` (byte-identical to today).
- `TelegramBotSender` (fake `fetch`): 1 photo + short text ⇒ `sendPhoto` with caption; 2 photos ⇒
  `sendMediaGroup`; long text ⇒ photos then text; no photos ⇒ today's `sendMessage`-only path.
- `SendChannels`: passes `photosFor(itemId)` into `sender.send`; `photosFor` undefined ⇒ `photos: []`.
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, manual)

`send:channels` a post that has a photo (to `--target x` and/or `telegram`) and confirm the media
appears on the live post. (Live send is final — use a test account/chat.)

## Files touched

- Create: `src/adapters/content/xMediaLookup.ts` (+ test)
- Modify: `src/ports/ChannelSender.ts` (`SendRequest.photos`), `src/app/SendChannels.ts` (`photosFor`
  dep + pass), `src/adapters/send/TypefullySender.ts` (upload flow), `src/adapters/send/TelegramBotSender.ts`
  (photo path), `src/cli/send-channels.ts` (wire `photosFor`)
- Tests: `tests/adapters/content/xMediaLookup.test.ts`, extend `TypefullySender`/`TelegramBotSender`/`SendChannels` tests
