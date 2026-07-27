# t.co URL expansion + media-link stripping at collection — design

Date: 2026-07-28
Status: approved for planning
Scope: normalize X tweet text at collection so links are real URLs, not `t.co` shortlinks, and so
a tweet's own media attachments (photo/video) stop leaking into the text as useless self-links.
One subsystem — the twitterapi.io adapter's tweet normalization. Surfaced by the first real E2E run
(a Korean Telegram announcement went out carrying `https://t.co/…` and a `.../photo/1` self-link).

## Context

Twitter renders every link in a tweet's body as an opaque `t.co` shortlink inside the `text` field,
and provides the real destination separately in `entities.urls[].expanded_url`. Our adapter
(`src/adapters/twitterapi/schemas.ts`) stores `text` verbatim and captures `extendedEntities.media`,
but **never reads `entities.urls`** — so the `expanded_url` mapping is discarded and only `t.co`
survives into translation, conversion, and delivery.

Verified live against twitterapi.io during the E2E investigation:

- A tweet with a real link returns
  `entities.urls: [{ url: "https://t.co/zftExlPu6s", expanded_url: "http://fluxion.network/trade",
  display_url: "fluxion.network/trade", indices: [...] }]`.
- A tweet whose only `t.co` is an **attached photo/video** returns `entities.urls: undefined` — the
  media lives in `extendedEntities.media` (which we already parse into `SourceTweet.media`). So a
  `t.co` that resolves to `.../photo/1` or `.../video/1` is not a link at all; it is the tweet's own
  attachment represented as text.
- An X Article tweet returns `entities.urls: [{ expanded_url: "http://x.com/i/article/<id>", … }]` —
  a real (if X-hosted) URL.

Two problems, one root cause and one fix: capture `entities.urls`, replace each `t.co` with its
`expanded_url`, and strip any remaining `t.co` (the media attachments). No network resolution is
needed — the API already returns everything.

## Decisions

### 1. Normalize at collection, in `normalizeTweet`

The transformation runs where the raw tweet becomes a domain `SourceTweet` (`normalizeTweet` in
`schemas.ts`), so the **stored** `text` is already clean and every downstream stage — translation
worksheet, conversion, formatting, delivery — sees real URLs. Existing collected tweets are not
migrated automatically; re-collecting a window (`pnpm collect Mantle_Official --since <date>`)
refreshes them through the new path (`LocalJsonStore.upsert` overwrites by id).

### 2. Expand real links; strip media links; keep X-self-references

`SourceTweet.text = expandUrls(rawText, entities.urls)`, where `expandUrls`:

1. For each entity `{ url, expanded_url }`, replaces every occurrence of `url` (the `t.co`) with
   `expanded_url` in the text.
2. Removes any `t.co` still present after step 1 — those are media attachments (not in
   `entities.urls`; already carried structurally in `SourceTweet.media`) — together with the
   whitespace that attached them, so `"… business as usual. https://t.co/abc"` becomes
   `"… business as usual."`.

Links whose `expanded_url` points back to X (an Article's own `x.com/i/article/<id>`, a quote-tweet
link) are **kept, expanded** — they are real URLs, and a human reviewer drops any unwanted one at
1차/2차 검수. No host-based special-casing (decided with Kyle: simplest correct rule, and it never
strips a legitimately useful quote link).

### 3. `expandUrls` — a pure helper, string replacement, `http` left as-is

- Lives in the adapter layer (`src/adapters/twitterapi/expandUrls.ts`) — it is twitterapi.io parsing,
  not domain logic — and is a pure `(text, urls) => text` function, independently testable.
- **String replacement, not index-based.** `t.co` shortlinks are unique tokens, so
  `text.split(url).join(expanded_url)` is robust and sidesteps the `indices` field's code-unit vs
  code-point ambiguity (emoji-heavy tweets).
- **`http://` is left as returned.** `expanded_url` sometimes arrives as `http://…`; the site
  redirects to https, and rewriting another party's scheme is out of scope (noted as a possible
  later nicety, not done here).

## Architecture

- **New:** `src/adapters/twitterapi/expandUrls.ts` — `expandUrls(text: string, urls?: { url?: string;
  expanded_url?: string }[]): string` (skips any entity missing `url` or `expanded_url`).
- **Modify:** `src/adapters/twitterapi/schemas.ts` — add an `entities` field to `TweetRaw`
  (`z.object({ urls: z.array(z.object({ url: z.string().optional(), expanded_url:
  z.string().optional() }).passthrough()).optional() }).passthrough().optional()`). The entity
  fields are **optional** so a malformed entry never aborts the whole-tweet parse; `expandUrls`
  skips any entity missing `url` or `expanded_url`. Change `normalizeTweet` to set
  `text: expandUrls(t.text, t.entities?.urls)`.
- **Tests:** `tests/adapters/twitterapi/expandUrls.test.ts` (the helper) and an added case in the
  existing tweet-normalization test (integration through `normalizeTweet`).
- **Docs:** `CHANGELOG.md`; a one-line note in `translation/style-guide.md` §11 that links now arrive
  expanded (t.co already resolved at collection; media links removed), so translators keep the real
  URL as-is. The §11 "preserve URLs" rule itself is unchanged — the URLs are simply real now.
- **Reuse:** the existing `MediaRaw`/`extendedEntities.media` parsing (unchanged — media is still
  carried on `SourceTweet.media`); `zod` for the schema; the existing normalization/test harness.

### Data flow

```
raw twitterapi.io tweet
  text: "… business as usual. https://t.co/PBvQMc7ao7"   (t.co = attached video)
        "Trade your favorite tokenized assets here: https://t.co/zftExlPu6s"  (t.co = real link)
  entities.urls: [{ url: "https://t.co/zftExlPu6s", expanded_url: "http://fluxion.network/trade" }]
  extendedEntities.media: [{ type: "video", … }]
        │
        ▼ normalizeTweet → expandUrls(text, entities.urls)
  step 1: replace t.co/zftExlPu6s → http://fluxion.network/trade
  step 2: strip t.co/PBvQMc7ao7 (not in entities.urls = media) + its leading whitespace
        ▼
  SourceTweet.text: "… business as usual."
                    "Trade your favorite tokenized assets here: http://fluxion.network/trade"
  SourceTweet.media: [{ type: "video", url: … }]   (unchanged)
```

## Error handling / edge cases

- **No `entities.urls` and no `t.co`** → text returned unchanged.
- **`entities.urls` present but a listed `t.co` is absent from text** (shouldn't happen) → the
  replace is a no-op; harmless.
- **A media `t.co` in the middle of the text** (rare) → the strip removes it and one adjacent space;
  the result is trimmed so no trailing/leading whitespace remains.
- **Multiple real links** → each entity is replaced independently.
- **Malformed entity** (missing `url` or `expanded_url`) → the schema marks both fields optional, so
  the entry parses; `expandUrls` skips it (no replacement for that entity), and its `t.co`, if any,
  is then treated as a media link and stripped in step 2. Normalization never throws on a live tweet.

## Testing

- `expandUrls`: a real link is replaced by its `expanded_url`; a media `t.co` (no matching entity) is
  removed with its attached whitespace and the text is trimmed; a tweet with **both** a real and a
  media `t.co` yields expanded-real + stripped-media; multiple real links each expand; empty/absent
  `urls` with no `t.co` returns the text unchanged; an X-self `expanded_url` (`x.com/i/article/…`) is
  kept. Every assertion pins the exact resulting string.
- `normalizeTweet`: a raw tweet carrying `entities.urls` + `extendedEntities.media` produces a
  `SourceTweet` whose `text` contains the expanded URL and **no** `t.co`, while `media` is still
  populated from `extendedEntities`.
- All synthetic fixtures — no live call, no real tokens.

## Non-goals

- **Media placeholders** — a stripped photo/video leaves nothing in the text (media is already on
  `SourceTweet.media` for any future use); no `[이미지]` marker this slice.
- **`http`→`https` normalization** of expanded URLs.
- **Migrating already-collected tweets** — re-collect to refresh.
- **Bold/formatting in announcements** — that is item (c), a separate conversion-layer discussion,
  not this spec.
- **Editing messages already sent** in the E2E run.
- **Resolving t.co over the network** — unnecessary; `entities.urls` already carries the destination.

## Global constraints

- Runtime deps stay **zod-only**; the new schema field uses `zod`; no network call is added.
- Normalization **never throws** on a live tweet — a missing/malformed `entities` degrades to
  "strip media t.co, keep the rest", never an abort (matches the existing tolerant parsing).
- `SourceTweet.media` and all other fields are unchanged — this touches only `text`.
- Public repo: tests use synthetic tweets only; no real tokens or PII.

## Open items to verify (not blockers to planning)

- After merge, re-collect a recent Mantle_Official window and confirm a stored tweet's `text` now
  shows `fluxion.network/trade` (expanded) and no `.../photo|video` `t.co` remains.
- Confirm a quote-tweet's link expands cleanly (kept, per Decision 2) on a real quote tweet in the
  window — the E2E items had none.
