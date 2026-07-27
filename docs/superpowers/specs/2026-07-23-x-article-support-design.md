# X Article ingestion — design

**Date:** 2026-07-23
**Status:** approved
**Scope:** collection + translation only. An X Article's real body is fetched, rendered to markdown,
and flows through the existing translate → review → publish path. The conversion (§5) and channel
formatting (§6) stages are explicitly **not** touched — see "Non-goals".

## Context

### This closes a live defect, not a missing feature

`advanced_search` already returns X Articles inside a normal `from:<user>` result set. They are
tweets with a tweet id, an author, and metrics — the pipeline collects them today. What it does
**not** do is read the body:

`TweetRaw` (`src/adapters/twitterapi/schemas.ts:8`) validates `id / url / text / createdAt /
author / quoted_tweet / counts / extendedEntities` and ignores everything else. For an Article
tweet, `text` is a bare t.co link:

```json
{ "text": "https://t.co/pa1EbjOsdZ",
  "article": { "title": "Phase 1: ClawHack, The Turing Test Hackathon Begins",
               "preview_text": "AI isn't just a narrative anymore…",
               "cover_media_img_url": "https://pbs.twimg.com/media/HFjTzAgaQAA1DzU.jpg" } }
```

`XContentSource` then turns that link into `ContentItem.text`, and a 12,000-character report enters
the translation queue as one URL. No error, no warning.

**Measured, not assumed.** All 12 of `Mantle_Official`'s articles were fetched live on 2026-07-23:
every one has `text` = a single t.co link, and bodies run **3,774 – 12,215 characters**. In a
916-tweet sample of the same account, 8 were Articles (~0.9%).

### What the API actually returns

Two endpoints, both verified live:

| Endpoint | Params | Returns |
|---|---|---|
| `GET /twitter/user/articles` | `username` (**all lowercase**) + `cursor` | `{status, code, msg, data:{articles[]}, has_next_page, next_cursor}` — tweet-shaped rows |
| `GET /twitter/article` | `tweet_id` (**snake_case**) | `{article, status, msg}` — the full body |

`article.contents` is a **Draft.js raw content-block array**, not HTML and not markdown:

```json
{ "type": "unstyled",
  "text": "Introducing The Turing Test Hackathon — Mantle's flagship AI Hackathon, co-hosted with @Bybit_Official and @byreal_io.",
  "inlineStyleRanges": [ { "offset": 87, "length": 16, "style": "Bold" } ] }
{ "type": "image", "url": "https://pbs.twimg.com/media/HFjMjT_aMAACN55.jpg", "width": 1280, "height": 720 }
```

The vocabulary is a **closed set**, measured across all 12 articles (900 blocks):

| Block type | Count |
|---|---|
| `unstyled` | 334 |
| `unordered-list-item` | 298 |
| `divider` | 88 |
| `header-two` | 75 |
| `ordered-list-item` | 72 |
| `image` | 23 |
| `header-one` | 10 |

Across those 900 blocks the only keys that ever appear are `type`, `text`, `inlineStyleRanges`, and
— on `image` blocks only — `url`, `width`, `height`. The only inline styles are `Bold` and `Italic`.

There is **no `entityRanges` key on any block** — Draft.js's link/entity mechanism is absent from
this payload. URLs appear as plain text inside `text` (12 such blocks observed), so nothing is lost
in the sample. See "Known limitations" for what this cannot rule out.

## Decisions

### 1. An Article is a kind of X post, not a separate source

`SourceTweet` gains an optional `article`; the item id stays `x:<rootId>`; there is no new store and
no new `ContentItem.source` value.

Rejected: a separate `ArticleContentSource` + `output/x-articles/`. It is cleaner only in isolation.
In context it costs:

- **`reconcile` and `impressions:record` would need a second store.** Both drive off `fetchByIds`
  with tweet ids (deletion detection; view counts). An Article *is* a tweet with a tweet id, so both
  work unchanged under this decision.
- **A second watermark and a second coverage ledger.** Discovery would move to
  `/twitter/user/articles`, duplicating what `output/x/state.json` and `output/x/runs.json` (PR #47)
  already do for the same account.
- **The stated reason for splitting does not survive the port boundary.** Block-array-vs-plain-text
  is a real structural difference, but it is resolved inside the adapter: what crosses
  `ContentSource` is still one `ContentItem.text` string. Splitting a port that nothing structurally
  different passes through produces duplication, not separation.

The one thing worth keeping from that option — a 12,000-character item is indistinguishable from a
280-character one before you open it — is a **display** concern, not a storage one: `ContentItem.kind`
below labels it in the translation worksheet. It does not (yet) reach the dashboard's
post-translation review queue; see Decision 4 for exactly what is and isn't built.

### 2. Store the blocks; render on read

`output/x/items.json` holds the raw block array. `XContentSource` renders markdown at
`loadPending()` time.

This is the lesson PR #50 recorded in reverse: when the stored artifact is already processed, a
change to the processing rules cannot be applied without re-collecting. Keeping the blocks means the
mapping below can be corrected later without re-running `collect`.

### 3. Block → markdown mapping

| Draft.js | Markdown | Note |
|---|---|---|
| `header-one` | `# ` | |
| `header-two` | `## ` | |
| `unstyled` | paragraph | |
| `ordered-list-item` | `1. ` | |
| `unordered-list-item` | `- ` | |
| `divider` | **dropped** (paragraph break only) | see below |
| `image` | `![](url)` | |
| `Bold` | `**…**` | |
| `Italic` | **flattened to plain text** | see below |

**`divider` must never render as `---`.** `toCanonical` (`src/domain/formatting/canonical.ts:45`)
absorbs a lone `---` line as a post boundary — the pipeline's thread separator since collection.
Emitting `---` for 88 dividers would split articles into dozens of "tweets". Dropping it is not a
workaround but the correct reading: **77 of the 88 dividers are immediately followed by a heading**
(67 `header-two` + 10 `header-one`), so they are decoration in front of a section marker that
already exists. The remaining 11 precede an `unstyled` block and fold into a paragraph break. No two
dividers were ever adjacent.

**`Italic` is dropped** because it appears **6 times across all 12 articles** (against hundreds of
Bold ranges): an editorial-series disclaimer twice, one pull-quote, and two "Format: …" lines. The
quote's meaning is carried by its own quotation marks. Adding an italic to the canonical vocabulary
would touch the canonical spec, six emitters, and their tests; six ranges do not pay for that.

**`image` is kept** even though it is not translatable text. `conversion/checklist.x.md` §10 makes
asset/text consistency a publication gate (an asset showing a stale date blocks release); dropping
images removes the reviewer's evidence.

### 4. `ContentItem` gains `kind?: "post" | "article"`

One optional discriminator on the existing source-agnostic type. It does not change routing or
storage. `XContentSource` sets it, and today exactly one place reads it: `assembleItemBlock`
labels the item's heading in the translation worksheet (`### <id> [article]`) so a reviewer
preparing translations can tell a 12,000-character item from a 280-character one before opening it.

That is the whole of what is built. It does **not** reach the dashboard's post-translation review
queue — `Translation` (what the dashboard reads once a translation is saved) has no `kind` field —
so a reviewer approving translations cannot yet tell an article from a post there. Wiring `kind`
through `Translation` and the dashboard is future work, not implied by this decision.

## Architecture

```
[new]  src/domain/articleMarkdown.ts          blocks → markdown (pure, no I/O)
[edit] src/domain/models.ts                   SourceTweet.article?: ArticleBody
[edit] src/adapters/twitterapi/schemas.ts     article on TweetRaw + block schema + toArticle
[edit] src/adapters/twitterapi/TwitterApiSourceGateway.ts   fetchArticle(tweetId)
[edit] src/ports/SourceGateway.ts             fetchArticle to the interface
[edit] src/app/CollectAuthoredContent.ts      fillArticleBodies() enrichment pass
[edit] src/adapters/content/XContentSource.ts render article markdown into ContentItem.text
[edit] src/domain/translation/contentItem.ts  kind?: "post" | "article"
[edit] src/adapters/store/LocalJsonStore.ts   mergeTweet: a stored article body survives a
                                               blockless/article-less incoming tweet (see
                                               "Live verification" below)
```

The block→markdown conversion is a **pure domain function** with no knowledge of HTTP or files. The
adapter calls it; the port still carries a string.

### Data flow

```
advanced_search page
  └ raw.article = {title, preview_text, cover_media_img_url} | null
     ↓ normalizeTweet
SourceTweet.article = {title, previewText, coverImageUrl, blocks: undefined}   ← body not yet fetched
     ↓ CollectAuthoredContent.fillArticleBodies()
       for each tweet with article && !blocks, and not already stored → source.fetchArticle(id)
     ↓ repo.upsert
output/x/items.json                                    ← raw blocks stored
     ↓ XContentSource.loadPending
ContentItem { text: renderArticle(article), kind: "article" }
```

`fillArticleBodies` sits beside `gapFillMissingRoots` (`src/app/CollectAuthoredContent.ts:84`) and
copies its shape: after fetching, make extra gateway calls to fill in data the list response omits.
No new concept is introduced.

Detection is free — the `article` field on the search response tells us which tweets need the extra
call, so cost is one request per Article tweet (~1% of tweets, 12 in this account's history).

## Error handling

Follows the gateway's existing `normalizeOrSkip` policy: **one bad Article never aborts a collect.**

| Case | Behaviour |
|---|---|
| Article payload fails schema validation | `console.warn`, tweet kept without a body |
| `fetchArticle` fails (HTTP/network) | `console.warn`, tweet kept without a body |
| `blocks` present but empty | falls back to link-only — **but now warns**, where today it is silent |

Observation, deliberately not fixed here: `gapFillMissingRoots` has no `try/catch`, so a
`fetchThread` failure aborts the whole collect. That is inconsistent with the policy above and with
`normalizeOrSkip`, but it is pre-existing and out of scope.

## Testing

- **`articleMarkdown.test.ts`** — all 7 block types; divider dropped; italic flattened; image;
  empty `contents`. The genuine hazard is **applying `inlineStyleRanges`**: `offset`/`length` index
  into the string, so multiple ranges must be applied back-to-front. Adjacent ranges, a range at
  index 0, and a range ending at the last character are each pinned explicitly.
- **Fixture** — one real response, abridged. The repo is public, so the full text of a third party's
  article is not committed; the fixture exists to pin structure.
- **`XContentSource`** — a thread carrying an article yields rendered markdown and `kind: "article"`;
  a normal thread is unchanged.
- **`CollectAuthoredContent`** — `fetchArticle` called exactly once for an Article tweet, zero times
  otherwise, and a failing `fetchArticle` leaves the collect complete.

## Non-goals

- **§5 conversion and §6 formatting are untouched.** A translated article contains `##` and `- `,
  which are not in the canonical vocabulary (`**bold**`, `[text](url)`, blank-line paragraph,
  double-blank-line post boundary). Running `convert --types x` on an article today would leak
  literal `##` into a tweet. This is a documented boundary, to be addressed separately if article →
  post summarisation is ever wanted.
- **Publishing a Korean X Article** (new `ConversionType`/`Channel`, Typefully `x_article` via
  `content_markdown`). Depends on the unbuilt §8 delivery adapters.
- **`/twitter/user/articles` as a discovery path.** `advanced_search` already surfaces articles;
  adding a second discovery route would fork the watermark and the coverage ledger.

## Live verification (2026-07-23)

Run against the real API on the ClawHack article (`2042617042537451733`), with temp storage so the
project's own `output/` was untouched: detected from `advanced_search` with its title, 77 blocks
fetched, rendered to **5,880 characters** where the tweet's own `text` is 23. Title rendered as
`# `, no lone `---` line anywhere, 58 `**` delimiters all balanced, **zero** whitespace-edged bold
spans, 22 list items sequentially numbered, the one image preserved.

**Found while verifying, and worth knowing:** `GET /twitter/tweets?tweet_ids=` — the endpoint behind
`fetchByIds` — **does not return the `article` field at all**, while `advanced_search` does.
Confirmed since: `GET /twitter/tweet/thread_context` — the endpoint behind `fetchThread`, which
`gapFillMissingRoots` calls to pull in a missing thread root — **omits the field too**
(`tests/adapters/articleFieldAvailability.probe.test.ts` pins both, for the same known article
tweet).

That second gap means the conclusion isn't "article detection works on the collection path" —
`thread_context` *is* on the collection path (`gapFillMissingRoots` runs on every `collect`) and
still can't detect an article. Detection works only through `advanced_search` specifically: a thread
root pulled in via `thread_context` is normalized with `article: undefined` regardless of whether
the real tweet is an Article. `fetchByIds` stays harmless for the reason already given — it serves
`reconcile` (deletion checks) and `impressions:record` (view counts), neither of which needs the
field, and neither writes tweets back into the collection store. `thread_context` is not harmless in
the same way: `gapFillMissingRoots` does write its results back into `fetched`, and from there into
`repo.upsert`. That is the entire reason `LocalJsonStore.mergeTweet` (see the Architecture list
above) refuses to let an incoming tweet's absent-or-blockless `article` overwrite a stored one —
without that guard, a gap-filled re-normalize of an Article's own root would silently revert its
stored body to a bare link on the next collect. Anything that tries to detect or backfill articles
through either `fetchByIds` or `thread_context` will silently find none.

## Known limitations

- **Once an article body is stored, no code path ever re-fetches it.** `fillArticleBodies`
  deliberately skips any tweet whose id already has `blocks` in the collection repository — a good
  body must never be put at risk of a transient failure or an empty response overwriting it (see
  `LocalJsonStore.mergeTweet`). This is separate from Decision 2's "the mapping can be corrected
  later without re-running collect": that's true of the block→markdown *rendering* logic, which runs
  fresh on every `loadPending()`. It is not true of the *raw blocks themselves*. There is no flag, no
  `--refetch`, no TTL, and no other trigger to fetch them again: an incomplete first fetch, or X
  itself editing the article afterward, has no supported recovery short of hand-editing (or deleting
  the `article.blocks` key from) `output/x/items.json` and re-running collect.
- **Anchor-text links cannot be recovered.** Blocks carry no `entityRanges`, so a hyperlink attached
  to a span of text has nowhere to live. No article in the 12-article sample used one (every URL was
  plain text in `text`), but if one exists the link is silently lost — and nothing in the payload
  lets us detect that it was there.
- **`viewCount` is a string in the article response** (`"90334"`) where the tweet response uses a
  number. Harmless today because article metrics are not consumed, but the schema must not assume
  the tweet shape.
- The publish path renders `# <itemId>` / `## 원문` / `## 한글` (`src/domain/publish/renderers.ts`).
  An article body's own `##` headings will sit at the same level as those section markers. Cosmetic;
  not worth a heading-shift pass.
