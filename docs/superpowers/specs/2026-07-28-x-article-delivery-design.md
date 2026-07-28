# Channel delivery: X Article (article → Typefully long-form) — Design

**Date:** 2026-07-28
**Branch:** `feat/x-article-delivery` (off `main`)
**Status:** approved for planning
**Sequel to:** photo media attachment (PR #72) — reuses its Typefully media-upload flow.

## Motivation

An X **Article** (Mantle's long-form, e.g. `x:2072340833760936293` "RWA in Full Force") is currently
converted to a **Telegram 공지 summary** (§5 `announcement`) and sent to Telegram only — it is never
reposted to X as an article. Kyle wants it posted to X **as an X Article** (X Premium account
confirmed) **in addition to** the existing Telegram 공지 (both, not either/or).

The article's **Korean translation already IS X-Article markdown**: the article keeper's `koreanText`
(8552 chars) has a leading `# 제목`, 11 `##` subheadings, markdown body, and an inline
`![](https://pbs.twimg.com/media/…jpg)` image — exactly what X Article wants. So no §5/§6
transform is needed; the translation is the deliverable.

**Typefully v2 X-Article draft format** (verified live via the API reference):
```json
{ "platforms": { "x_article": { "content_markdown": "…", "cover_media_id": "…" } },
  "publish_at": "now" }
```
- `x_article` is **standalone** (no `enabled`, no `posts` — unlike the `x` platform), fields:
  - `content_markdown` (required, ≤50000): first non-empty block must be `# Title`; body supports
    paragraphs, blockquotes, lists, `#`/`##` headings, bold/italic/strike, links, `---`/`***`
    dividers. **Inline media is block-only, alone on a line: `<typ:media media_id="…" />`.**
  - `cover_media_id` (nullable): an uploaded, ready, account-owned static image.
- The published url comes back as **`x_article_published_url`** (`https://x.com/i/article/<id>`),
  NOT `x_published_url`.

## Approach

A dedicated **`SendXArticle`** use-case + **`send:x-article`** CLI, operating directly on approved
**article** translations (not on `ChannelRendering`s — the article translation is the content). It
uploads the article's images via the **shared Typefully media flow extracted from PR #72**, rewrites
`![](url)` → `<typ:media media_id="…" />`, and posts the `x_article` draft. The Telegram 공지 path is
untouched.

## Design

### Shared Typefully media upload (refactor of PR #72)

PR #72's `TypefullySender.uploadPhotos` is inlined + private. Extract the per-URL flow into a reusable
`src/adapters/send/TypefullyMedia.ts`:
```ts
export class TypefullyMedia {
  constructor(apiKey, socialSetId, fetchFn = fetch, sleep = …) {}
  /** download bytes → POST /media/upload → PUT presigned S3 → poll /media/{id} until ready → media_id */
  upload(url: string): Promise<string>;
}
```
`TypefullySender` is refactored to compose `TypefullyMedia.upload` per photo (behavior unchanged — its
tests stay green). `SendXArticle` uses the same class. (Pure refactor + reuse; no behavior change to #72.)

### Article metadata lookup

`src/adapters/content/xArticleMeta.ts` → `xArticleMeta(itemsPath): (itemId) => Promise<{ isArticle: boolean; coverImageUrl?: string }>`
reads items.json, finds the thread, and reports whether any tweet is an article (`tweet.article`) and
its `article.coverImageUrl`. Never throws (missing/corrupt file → `{ isArticle: false }`). Mirrors
`xPhotos`.

### content_markdown builder (pure)

`src/domain/publish/articleMarkdown.ts` (new) → `toXArticleMarkdown(koreanText, mediaIdByUrl): string`:
replaces each `![](<url>)` occurrence with `<typ:media media_id="<id>" />` (on its own line, using the
uploaded media_id for that url from the map); leaves text with no images unchanged; an image whose url
is absent from the map is left as-is (defensive — the use-case always uploads first). Pure, unit-tested.
(Image refs are already block-level in the article render, so the replacement is line-safe.)

### `TypefullyArticleSender`

`src/adapters/send/TypefullyArticleSender.ts`:
```ts
send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }>;
```
POSTs `{ platforms: { x_article: { content_markdown, cover_media_id? } }, publish_at: "now" }`, then
(like PR #72's tweet sender) reads `x_article_published_url` from the create response or polls the draft
for it; `postId` = the article id parsed from `…/i/article/<id>`.

### `SendXArticle` use-case

`src/app/SendXArticle.ts`. Deps: `TranslationStore`, `articleMeta: (itemId)=>Promise<{isArticle,coverImageUrl?}>`,
`media: { upload(url): Promise<string> }`, `sender: { send(...) }`, `ledger: { loadKeys(): Promise<Set<string>>; add(itemId, res): Promise<void> }`, optional `record?`, `now`.
```
run({ ids? }):
  for each approved translation t:
    meta = await articleMeta(t.itemId); if (!meta.isArticle) continue      // articles only
    if (ids && !ids.has(t.itemId)) continue
    if (ledger has t.itemId) { skipped++; continue }
    urls = unique([...koreanText matches of ![](url)..., meta.coverImageUrl?])
    mediaIdByUrl = new Map(); for (url of urls) mediaIdByUrl.set(url, await media.upload(url))   // upload first
    content_markdown = toXArticleMarkdown(t.koreanText, mediaIdByUrl)
    cover_media_id = meta.coverImageUrl ? mediaIdByUrl.get(meta.coverImageUrl) : undefined
    res = await sender.send({ content_markdown, cover_media_id })          // any failure → this item failed, not ledgered (retryable)
    ledger.add(t.itemId, res)  (best-effort: a ledger-write failure after send warns, counts as sent — mirrors SendChannels)
    record?(…)  (best-effort history)
  return { sent, skipped, failed }
```
**Idempotency:** a dedicated ledger `output/publish/x-article.json` (`{ posted: [{ itemId, postId, url, sentAt }] }`,
keyed by itemId — one X Article per item), via a small `JsonXArticleLedger` (mirrors `JsonChannelLedger`).
Upload happens **before** the draft POST so a media failure never makes a partial live post.

### CLI

`src/cli/send-x-article.ts` (`pnpm send:x-article [--ids …]`): wires `TranslationStore`, `xArticleMeta(paths.xItems)`,
`TypefullyMedia`/`TypefullyArticleSender` from `loadTypefullyConfig()`, `JsonXArticleLedger`, and the
optional Sheet recorder (reuse `buildRecorder`). `skipIfLocal`-free (send works in any mode, like send:channels).

## Non-goals

- Editing/deleting a posted X Article; scheduling (publish-now only); the Telegram 공지 path (unchanged).
- Non-article items (they go through the normal `x`/announcement paths).
- Comment-thread anchor markers (GET/PATCH round-trip concern — we only create).
- Video in the article body (part-1's video follow-up applies).

## Testing

- `toXArticleMarkdown` (pure): one image → `<typ:media>`; multiple; none → unchanged; unmapped url left as-is.
- `xArticleMeta` (fixture): article tweet → `{isArticle:true, coverImageUrl}`; non-article/missing/corrupt → `{isArticle:false}`.
- `TypefullyMedia.upload` (fake fetch): download→upload→PUT→poll-ready→media_id (the flow moved from #72).
- `TypefullyArticleSender` (fake fetch): POST body has `platforms.x_article.content_markdown` (+ `cover_media_id` when given), no `enabled`; reads/polls `x_article_published_url`; `postId` parsed from `/i/article/<id>`.
- `SendXArticle` (fakes): selects only article translations; uploads all images before send; builds `content_markdown` with `<typ:media>`; sets `cover_media_id`; ledgers itemId; skips already-posted; a media failure → failed + not ledgered.
- `TypefullySender` (PR #72) tests stay green after the `TypefullyMedia` extraction.
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, manual)

`pnpm send:x-article --ids <article-id>` against a **test** X Premium account; confirm the article
posts with its title, headings, inline image, and cover. Live publish is final.

## Files touched

- Create: `src/adapters/send/TypefullyMedia.ts`, `src/adapters/send/TypefullyArticleSender.ts`,
  `src/adapters/content/xArticleMeta.ts`, `src/domain/publish/articleMarkdown.ts`,
  `src/app/SendXArticle.ts`, `src/adapters/store/JsonXArticleLedger.ts`, `src/cli/send-x-article.ts` (+ tests)
- Modify: `src/adapters/send/TypefullySender.ts` (compose `TypefullyMedia`), `package.json` (`send:x-article` script),
  `paths.ts` if a new artifact path is needed for the ledger
