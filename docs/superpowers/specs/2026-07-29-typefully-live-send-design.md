# Typefully live-send fixes: media upload + scheduled publish — Design

**Date:** 2026-07-29
**Branch:** `fix/typefully-live-send` (off `main`)
**Status:** approved for planning

## Motivation

The first real live X send of photo + URL posts (this session, on the test account @bcd_kyle) failed
two independent ways — both first-time-live paths PR #72/#73 shipped but never live-verified:

1. **Media upload — HTTP 403 `SignatureDoesNotMatch`.** `TypefullyMedia` uploads bytes to Typefully's
   presigned S3 URL with a `Content-Type` header, but the URL is signed **without** one, so S3
   recomputes a different StringToSign and rejects it. **Confirmed live:** the same PUT with the
   `Content-Type` header removed returns **200** (the twimg download itself is fine — 200, correct bytes).

2. **URL tweet — HTTP 403 `FORBIDDEN: Direct publishing of X drafts containing URLs is blocked`.**
   Both `publish_at: "now"` tweets that contain a link (the @nansen quote-tweet, the fluxion.network
   video post) are blocked by X's anti-spam policy on **direct/immediate** API publishing.
   **Confirmed live:** the same draft created with a **future `publish_at`** (scheduled) returns **201**
   — scheduling routes through Typefully's queue (the user's session, which allows URLs). The test
   draft was created (+1h) and deleted (204) to verify without a live post.

(The X_PREMIUM long-form limit from PR #75 worked: the over-280 posts passed the send guard and
reached the publish step — they failed on the URL policy, not the length.)

## Approach

Two focused fixes to the Typefully adapters. Kyle approved this direction ("일단 이렇게 하자"):

1. **`TypefullyMedia`**: drop the `Content-Type` header from the S3 PUT.
2. **Both senders** (`TypefullySender`, `TypefullyArticleSender`): replace `publish_at: "now"` with a
   **near-future scheduled time** (`+2 min`), so every X send routes through Typefully's URL-safe
   scheduled-publish path. A scheduled draft is not published yet, so its `x_published_url` /
   `x_article_published_url` is null at create time — the sender therefore returns the draft's
   **`share_url`** (a working Typefully link to the scheduled post) and drops the now-pointless
   published-url poll.

**Accepted trade-offs (deliberate, "일단"):**
- Posts go live ~2 minutes after `send:channels` / `send:x-article` runs, not instantly.
- The ledger records the Typefully **`share_url`** (not the final `x.com/...` url) and the Typefully
  **draft id** (not the X tweet/article id). §9b impression tracking looks posts up by X tweet id via
  twitterapi.io, so it cannot process these until the real id is reconciled later — a documented
  follow-up, out of scope here. (§9b is X-only and not always run.)

## Design

### `TypefullyMedia.upload` (S3 PUT)

Change the PUT to send **no `Content-Type`** (the presigned signature does not include it):
```ts
const put = await this.fetchFn(upload_url, { method: "PUT", body: bytes });
```
The `contentType` local is no longer needed. Everything else (download, POST /media/upload, poll
until `ready`) is unchanged. Fixes media for both tweet photos and article inline/cover images.

### Scheduled publish (both senders)

- A shared constant `PUBLISH_DELAY_MS = 2 * 60 * 1000`.
- An injectable `now: () => number = () => Date.now()` ctor field (last param, after `sleep`) so the
  scheduled timestamp is deterministic in tests.
- The POST body uses `publish_at: new Date(this.now() + PUBLISH_DELAY_MS).toISOString()` instead of
  `"now"`.
- Read `share_url` from the create response; return `{ postId: draftId, url: share_url }`.
- **Remove the published-url poll loop** in both senders (a scheduled draft is never published within
  the poll window; the loop would only ever time out). The `parseTweetId`/`parseArticleId` helpers
  and the not-ok-response error handling stay.

`TypefullySender` return shape:
```ts
const draft = (await create.json()) as { id?: number | string; share_url?: string };
const draftId = draft.id !== undefined ? String(draft.id) : undefined;
return { postId: draftId, url: draft.share_url };
```
`TypefullyArticleSender` is the same shape (its `send({ content_markdown, cover_media_id? })` signature
is unchanged).

### No CLI / use-case changes

`SendChannels` and `SendXArticle` are untouched — they already treat any thrown error as a failure and
a returned `{postId,url}` as a success + ledger it. A scheduled send is a success (the draft is
created and queued); the idempotency ledger prevents re-scheduling on a rerun.

## Non-goals

- Reconciling the final X tweet/article id + url after the scheduled post publishes (a later
  follow-up; enables §9b for these).
- Conditional scheduling (only URL posts) — schedule **all** X sends uniformly, simpler and URL-safe.
- A configurable per-call offset or a runtime "publish now vs schedule" toggle.
- Changing the standard tweet/announcement/telegram paths (Telegram is unaffected — this is X only).

## Testing

- `TypefullyMedia` (fake fetch): the S3 PUT is called with **no `Content-Type` header** and the
  downloaded bytes as body; the ready-poll still returns the media_id. (Update the existing PR #72/#73
  media test that asserted the header.)
- `TypefullySender` (fake fetch, injected `now`): the POST body's `publish_at` is
  `now()+PUBLISH_DELAY_MS` as ISO (not `"now"`); the result is `{ postId: draftId, url: share_url }`;
  no draft-poll GET is issued. Media still uploads first (media_ids on posts[0]).
- `TypefullyArticleSender` (fake fetch, injected `now`): same `publish_at` + `share_url` assertions;
  body still carries `platforms.x_article.content_markdown` (+ `cover_media_id` when given).
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, manual)

Re-run the paused live send with `X_PREMIUM=true` already set:
`pnpm send:channels --target x,telegram` + `pnpm send:x-article --ids 2072340833760936293`. The four X
posts (photos attached, long-form allowed) + the X Article schedule +2 min and go live; the Telegram
공지 posts immediately (unaffected). Confirm on @bcd_kyle after the schedule window. The ledger's
`url` is the Typefully `share_url` for the X items until the id-reconcile follow-up lands.

## Files touched

- **Modify:** `src/adapters/send/TypefullyMedia.ts` (drop Content-Type),
  `src/adapters/send/TypefullySender.ts` (schedule + share_url, drop poll),
  `src/adapters/send/TypefullyArticleSender.ts` (schedule + share_url, drop poll)
- **Tests:** the three senders' tests (media header, publish_at, share_url)
