# Collection: quote-tweet link capture — Design

**Date:** 2026-07-28
**Branch:** `feat/quote-tweet-link` (off `main`)
**Status:** approved for planning

## Motivation

A quote tweet points at the tweet it quotes — e.g. Mantle's `x:2080608995371597892` ends with
"The full breakdown ↓", where the "↓" refers to the quoted @nansen_ai Q2 report. The quoted
tweet's URL **is** in the raw twitterapi.io payload (`quoted_tweet.url`), but our schema binds
`quoted_tweet` as `z.unknown()` and `normalizeTweet` keeps only the `isQuote` boolean
(`src/adapters/twitterapi/schemas.ts:63,140`) — the URL is dropped. So the translated review doc
shows a dangling "↓" with nothing to click.

Confirmed from the twitterapi.io reference and a real payload sample: `quoted_tweet` is a nested
tweet object carrying `id` and a canonical `url` like `https://x.com/<author>/status/<id>`.

## Approach

Capture `quoted_tweet.url` and **append it to the tweet's text, inline where the "↓" points**, so
the link flows through translation and the review doc automatically with no extra plumbing.

Decisions (approved):
- **Inline append**, not a separate structured field. The "↓" lives in the body, so the link
  belongs right after it (unlike a reply's `refUrl`, which is metadata *about* the tweet).
- **Link only** — do not inline the quoted tweet's own text (it is someone else's content and would
  land in our translatable source).
- **De-dup** — append only when the tweet text does not already contain that URL or the quoted
  tweet's id (some quote tweets already include it as a t.co that `expandUrls` expands).

## Design

### Schema (`src/adapters/twitterapi/schemas.ts`)

Replace the opaque binding with a lenient object that captures the fields we need and passes the
rest through (so `isQuote` derivation is unchanged and nothing else is lost):

```ts
// was: quoted_tweet: z.unknown().nullable().optional(),
quoted_tweet: z
  .object({ url: z.string().nullable().optional(), id: z.string().nullable().optional() })
  .passthrough()
  .nullable()
  .optional(),
```

`isQuote` stays `t.quoted_tweet !== null && t.quoted_tweet !== undefined` — an empty/quoted object
is still "present", so the boolean is unaffected.

### `normalizeTweet`

A small pure helper appends the quoted URL to the already-expanded text:

```ts
/** Surface the quoted tweet's link at the end of the text (where a "↓" points), unless it is
 *  already there. Returns text unchanged when there is no quoted URL. */
function appendQuotedUrl(text: string, quoted?: { url?: string | null; id?: string | null }): string {
  const url = quoted?.url ?? undefined;
  if (!url) return text;
  if (text.includes(url)) return text; // already present as itself
  if (quoted?.id && text.includes(quoted.id)) return text; // already present as a t.co-expanded link
  return `${text}\n${url}`;
}
```

`normalizeTweet` composes it after URL expansion:

```ts
text: appendQuotedUrl(expandUrls(t.text, t.entities?.urls ?? undefined), t.quoted_tweet ?? undefined),
```

Nothing else in `normalizeTweet` changes. The appended URL rides `SourceTweet.text` into the stored
`CollectedThread`, which `XContentSource` assembles into `ContentItem.text` for translation — so the
link appears in the worksheet, the translation, and the review doc with no further changes.

## Non-goals

- No structured `quotedUrl` field, no dashboard-specific display.
- No fetching or inlining the quoted tweet's body.
- No change to `isQuote`, media handling, article handling, or `expandUrls`.

## Testing

Unit tests on `normalizeTweet` (and/or the `appendQuotedUrl` helper), using minimal raw payloads:

- A quote tweet whose text does **not** contain the quoted URL → the URL is appended on a new line;
  `isQuote` is true.
- A quote tweet whose text **already contains** the quoted URL → text is unchanged (no duplicate).
- A quote tweet whose text already contains the quoted tweet's **id** (t.co-expanded) → unchanged.
- `quoted_tweet` present but **no url** → text unchanged; `isQuote` still true.
- **No** `quoted_tweet` → text unchanged; `isQuote` false (existing behavior preserved).
- A malformed `quoted_tweet` extra field does not throw (passthrough).

`pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Operational (after merge, not code)

Re-collect the recent Mantle items so existing keepers pick up their quoted links
(`pnpm collect …` for the reference account / recent window), then re-prepare/translate as needed.
This is an operator step, run manually — not part of the automated change.

## Files touched

- Modify: `src/adapters/twitterapi/schemas.ts` (schema binding + `appendQuotedUrl` + `normalizeTweet` wiring)
- Test: `tests/adapters/twitterapi/schemas.test.ts` (or a focused `normalizeTweet` test file)
