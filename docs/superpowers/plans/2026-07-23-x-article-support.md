# X Article ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect an X Article's real body instead of the bare t.co link the pipeline stores today, so a 12,000-character article reaches the translation queue as readable markdown.

**Architecture:** An Article is treated as a kind of X post, not a new source — `SourceTweet` gains an optional `article`, the item id stays `x:<rootId>`, and no new store is created. Block→markdown conversion is a pure domain function; the adapter calls it and the `ContentSource` port still carries a single string, so translation, review and publishing are unchanged.

**Tech Stack:** TypeScript (ESM), `zod` for runtime validation, `vitest` for tests, native `fetch` via the existing `HttpClient`.

**Spec:** `docs/superpowers/specs/2026-07-23-x-article-support-design.md`

## Global Constraints

- **`zod` is the only runtime dependency.** Do not add packages. Build-time devDeps are fine but none are needed here.
- **Hexagonal layering.** `src/domain/` must not import from `src/adapters/`, `src/ports/`, or do any I/O.
- **Code and comments in English.** (Korean is for `docs/ko/` and user-facing strings.)
- **Never emit `---` for a `divider` block.** `toCanonical` (`src/domain/formatting/canonical.ts:45`) absorbs a lone `---` line as a post boundary; emitting it would split an article into dozens of "tweets".
- Tests: `pnpm test` (all), `pnpm test <path>` (one file). Typecheck: `pnpm typecheck`.
- The spec names the renderer `src/domain/x/articleBlocks.ts`. This plan places it at **`src/domain/articleMarkdown.ts`** instead: X-collection domain files are flat in `src/domain/` (`models.ts`, `threadAssembler.ts`, `threadLimit.ts`, `coverage.ts`), and a new one-file subdirectory would break that.

---

### Task 1: Article domain types and the markdown renderer

The pure core. No I/O, no HTTP, no knowledge of twitterapi.io.

**Files:**
- Modify: `src/domain/models.ts` (append after `TweetMetrics`, before `SourceTweet`)
- Create: `src/domain/articleMarkdown.ts`
- Test: `tests/domain/articleMarkdown.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `interface InlineStyleRange { offset: number; length: number; style: string }`
  - `interface ArticleBlock { type: string; text?: string; inlineStyleRanges?: InlineStyleRange[]; url?: string; width?: number; height?: number }`
  - `interface ArticleBody { title: string; previewText?: string; coverImageUrl?: string; blocks?: ArticleBlock[] }`
  - `SourceTweet.article?: ArticleBody`
  - `renderArticle(article: ArticleBody): string` from `src/domain/articleMarkdown.ts`

- [ ] **Step 1: Add the domain types**

In `src/domain/models.ts`, insert after the `TweetMetrics` interface and before `SourceTweet`:

```ts
/** One styled span inside an article block. Offsets are UTF-16 code units, matching JS strings. */
export interface InlineStyleRange {
  offset: number;
  length: number;
  style: string; // observed: "Bold", "Italic"
}

/**
 * One Draft.js content block from an X Article body. `type` is deliberately a plain string
 * rather than a union: the seven observed values are a closed set today, but a value we have
 * never seen must render as a paragraph rather than fail validation.
 */
export interface ArticleBlock {
  type: string; // observed: unstyled | header-one | header-two | ordered-list-item | unordered-list-item | divider | image
  text?: string;
  inlineStyleRanges?: InlineStyleRange[];
  url?: string; // image blocks only
  width?: number;
  height?: number;
}

/**
 * An X Article riding on a tweet. The search response carries only `title`/`previewText`/
 * `coverImageUrl`; `blocks` is filled by a second call (see CollectAuthoredContent), so it is
 * undefined between collection steps and stays undefined if that call fails.
 */
export interface ArticleBody {
  title: string;
  previewText?: string; // ~200-character excerpt from the search response, not the body
  coverImageUrl?: string;
  blocks?: ArticleBlock[];
}
```

Then add one field to `SourceTweet`, after `media?: MediaItem[];`:

```ts
  article?: ArticleBody; // present only when this tweet is an X Article
```

- [ ] **Step 2: Write the failing test**

Create `tests/domain/articleMarkdown.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderArticle } from "../../src/domain/articleMarkdown";
import type { ArticleBlock } from "../../src/domain/models";

/** Abridged from a real GET /twitter/article response (Mantle_Official, 2026-04-10). */
const realBlocks: ArticleBlock[] = [
  { type: "divider" },
  { type: "header-two", text: "Introducing The Turing Test Hackathon" },
  {
    type: "unstyled",
    text: "Introducing The Turing Test Hackathon — Mantle's flagship AI Hackathon, co-hosted with @Bybit_Official and @byreal_io.",
    inlineStyleRanges: [
      { length: 16, offset: 87, style: "Bold" },
      { length: 11, offset: 107, style: "Bold" },
    ],
  },
  {
    type: "ordered-list-item",
    text: "The Giga Claw ($10,000 USD): Awarded to the top 100 participants by total trading volume.",
    inlineStyleRanges: [{ length: 29, offset: 0, style: "Bold" }],
  },
  {
    type: "ordered-list-item",
    text: "The Sharp Claw ($5,000 USD): Awarded to the top 50 participants by highest profit percentage (ROI).",
    inlineStyleRanges: [{ length: 29, offset: 0, style: "Bold" }],
  },
  { type: "image", url: "https://pbs.twimg.com/media/HFjMjT_aMAACN55.jpg", width: 1280, height: 720 },
];

describe("renderArticle", () => {
  it("renders a real article payload to markdown", () => {
    const out = renderArticle({ title: "Phase 1: ClawHack", blocks: realBlocks });

    expect(out).toBe(
      [
        "# Phase 1: ClawHack",
        "",
        "## Introducing The Turing Test Hackathon",
        "",
        "Introducing The Turing Test Hackathon — Mantle's flagship AI Hackathon, co-hosted with **@Bybit_Official** and **@byreal_io.**",
        "",
        "1. **The Giga Claw ($10,000 USD):** Awarded to the top 100 participants by total trading volume.",
        "2. **The Sharp Claw ($5,000 USD):** Awarded to the top 50 participants by highest profit percentage (ROI).",
        "",
        "![](https://pbs.twimg.com/media/HFjMjT_aMAACN55.jpg)",
      ].join("\n"),
    );
  });

  it("never emits --- for a divider (it would read as a post boundary downstream)", () => {
    const out = renderArticle({
      title: "T",
      blocks: [{ type: "unstyled", text: "a" }, { type: "divider" }, { type: "unstyled", text: "b" }],
    });
    expect(out).not.toContain("---");
    expect(out).toBe("# T\n\na\n\nb");
  });

  it("maps each block type to its markdown form", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        { type: "header-one", text: "H1" },
        { type: "header-two", text: "H2" },
        { type: "unstyled", text: "para" },
        { type: "unordered-list-item", text: "bullet" },
      ],
    });
    expect(out).toBe("# H1\n\n## H2\n\npara\n\n- bullet");
  });

  it("numbers a run of ordered items and restarts after an interruption", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        { type: "ordered-list-item", text: "one" },
        { type: "ordered-list-item", text: "two" },
        { type: "unstyled", text: "break" },
        { type: "ordered-list-item", text: "again" },
      ],
    });
    expect(out).toBe("1. one\n2. two\n\nbreak\n\n1. again");
  });

  it("keeps numbering across a dropped divider, since the divider produces no output", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        { type: "ordered-list-item", text: "one" },
        { type: "divider" },
        { type: "ordered-list-item", text: "two" },
      ],
    });
    expect(out).toBe("1. one\n2. two");
  });

  it("moves whitespace outside the bold markers", () => {
    // X's Bold ranges routinely include the trailing space. `**bold **text` is not emphasis in
    // CommonMark (the closing delimiter may not be preceded by whitespace) and would leak literal
    // asterisks into the translation.
    const out = renderArticle({
      title: "",
      blocks: [
        { type: "unstyled", text: "Label: value", inlineStyleRanges: [{ offset: 0, length: 7, style: "Bold" }] },
      ],
    });
    expect(out).toBe("**Label:** value");
  });

  it("merges adjacent bold ranges instead of emitting ****", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        {
          type: "unstyled",
          text: "abcdefghij",
          inlineStyleRanges: [
            { offset: 0, length: 5, style: "Bold" },
            { offset: 5, length: 5, style: "Bold" },
          ],
        },
      ],
    });
    expect(out).toBe("**abcdefghij**");
  });

  it("applies multiple ranges without shifting later offsets", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        {
          type: "unstyled",
          text: "aa bb cc",
          inlineStyleRanges: [
            { offset: 0, length: 2, style: "Bold" },
            { offset: 6, length: 2, style: "Bold" },
          ],
        },
      ],
    });
    expect(out).toBe("**aa** bb **cc**");
  });

  it("bolds a range that ends at the last character", () => {
    const out = renderArticle({
      title: "",
      blocks: [{ type: "unstyled", text: "abcde", inlineStyleRanges: [{ offset: 2, length: 3, style: "Bold" }] }],
    });
    expect(out).toBe("ab**cde**");
  });

  it("ignores an out-of-bounds range rather than throwing", () => {
    const out = renderArticle({
      title: "",
      blocks: [{ type: "unstyled", text: "abc", inlineStyleRanges: [{ offset: 1, length: 99, style: "Bold" }] }],
    });
    expect(out).toBe("abc");
  });

  it("drops Italic to plain text", () => {
    const out = renderArticle({
      title: "",
      blocks: [
        { type: "unstyled", text: "hello world", inlineStyleRanges: [{ offset: 0, length: 5, style: "Italic" }] },
      ],
    });
    expect(out).toBe("hello world");
  });

  it("renders an unknown block type as a paragraph", () => {
    const out = renderArticle({ title: "", blocks: [{ type: "blockquote", text: "quoted" }] });
    expect(out).toBe("quoted");
  });

  it("drops blank blocks and an image with no url", () => {
    const out = renderArticle({
      title: "T",
      blocks: [{ type: "unstyled", text: "   " }, { type: "image" }, { type: "unstyled", text: "kept" }],
    });
    expect(out).toBe("# T\n\nkept");
  });

  it("returns just the title when there are no blocks", () => {
    expect(renderArticle({ title: "Only title", blocks: [] })).toBe("# Only title");
    expect(renderArticle({ title: "Only title" })).toBe("# Only title");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/domain/articleMarkdown.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/domain/articleMarkdown"`.

- [ ] **Step 4: Write the implementation**

Create `src/domain/articleMarkdown.ts`:

```ts
import type { ArticleBlock, ArticleBody, InlineStyleRange } from "./models";

/**
 * Render an X Article's Draft.js content blocks as markdown, so the body can travel through the
 * pipeline as an ordinary `ContentItem.text` string.
 *
 * Two mappings are deliberate rather than obvious, and are argued in
 * `docs/superpowers/specs/2026-07-23-x-article-support-design.md`:
 *
 * - `divider` produces **nothing**. It must never become `---`: `toCanonical` reads a lone `---`
 *   line as a post boundary, so 88 dividers would shatter an article into dozens of "tweets". It
 *   is also redundant — 77 of 88 observed dividers sit directly in front of a heading.
 * - `Italic` is flattened. It appeared 6 times across 12 whole articles, and adding an italic to
 *   the canonical vocabulary would pull in the canonical spec, six emitters and their tests.
 */

/** What a rendered block is, for deciding the separator between it and its neighbour. */
type Piece = { text: string; kind: "ordered" | "unordered" | "block" };

/**
 * Combine Bold ranges that touch or overlap. Without this, two adjacent ranges render as
 * `**a****b**`, whose middle `****` is not valid emphasis.
 */
function mergeBoldRanges(ranges: InlineStyleRange[]): { offset: number; length: number }[] {
  const ascending = ranges
    .filter((r) => r.style === "Bold" && r.length > 0)
    .sort((a, b) => a.offset - b.offset);
  const merged: { offset: number; length: number }[] = [];
  for (const r of ascending) {
    const last = merged[merged.length - 1];
    if (last && r.offset <= last.offset + last.length) {
      last.length = Math.max(last.offset + last.length, r.offset + r.length) - last.offset;
    } else {
      merged.push({ offset: r.offset, length: r.length });
    }
  }
  return merged;
}

/**
 * Shrink a range so it does not start or end on whitespace. X's Bold ranges routinely include the
 * trailing space (`"The Giga Claw ($10,000 USD): "`), and CommonMark refuses to close emphasis on
 * a delimiter preceded by whitespace — `**bold **text` renders as literal asterisks.
 */
function trimRange(text: string, range: { offset: number; length: number }): { offset: number; length: number } {
  let { offset, length } = range;
  while (length > 0 && /\s/.test(text[offset])) {
    offset++;
    length--;
  }
  while (length > 0 && /\s/.test(text[offset + length - 1])) {
    length--;
  }
  return { offset, length };
}

/**
 * Wrap each Bold range in `**`. Ranges are applied back-to-front so an earlier insertion never
 * shifts a later range's offset. Offsets are UTF-16 code units, which is exactly what `slice`
 * indexes, so surrogate pairs need no special handling.
 */
function applyBold(text: string, ranges: InlineStyleRange[]): string {
  let out = text;
  for (const raw of mergeBoldRanges(ranges).reverse()) {
    if (raw.offset < 0 || raw.offset + raw.length > text.length) continue; // malformed payload
    const r = trimRange(text, raw);
    if (r.length === 0) continue;
    const end = r.offset + r.length;
    out = `${out.slice(0, r.offset)}**${out.slice(r.offset, end)}**${out.slice(end)}`;
  }
  return out;
}

/** One block → one piece, or null when the block contributes nothing. */
function renderBlock(block: ArticleBlock, ordinal: number): Piece | null {
  if (block.type === "divider") return null;
  if (block.type === "image") return block.url ? { text: `![](${block.url})`, kind: "block" } : null;

  const text = applyBold(block.text ?? "", block.inlineStyleRanges ?? []).trim();
  if (text === "") return null;

  switch (block.type) {
    case "header-one":
      return { text: `# ${text}`, kind: "block" };
    case "header-two":
      return { text: `## ${text}`, kind: "block" };
    case "ordered-list-item":
      return { text: `${ordinal}. ${text}`, kind: "ordered" };
    case "unordered-list-item":
      return { text: `- ${text}`, kind: "unordered" };
    default:
      return { text, kind: "block" }; // unstyled, and any type we have not seen
  }
}

export function renderArticle(article: ArticleBody): string {
  const pieces: Piece[] = [];
  const title = article.title?.trim();
  if (title) pieces.push({ text: `# ${title}`, kind: "block" });

  // Ordered items are numbered by position in their run; blocks that render to nothing (a divider,
  // a blank paragraph) do not interrupt it, because they leave no gap in the output either.
  let ordinal = 0;
  for (const block of article.blocks ?? []) {
    const piece = renderBlock(block, ordinal + 1);
    if (!piece) continue;
    ordinal = piece.kind === "ordered" ? ordinal + 1 : 0;
    pieces.push(piece);
  }

  // Items inside one list are one line apart; everything else is separated by a blank line.
  return pieces
    .map((piece, i) => {
      if (i === 0) return piece.text;
      const prev = pieces[i - 1];
      const sameList = prev.kind !== "block" && prev.kind === piece.kind;
      return (sameList ? "\n" : "\n\n") + piece.text;
    })
    .join("");
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/domain/articleMarkdown.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/domain/models.ts src/domain/articleMarkdown.ts tests/domain/articleMarkdown.test.ts
git commit -m "feat(domain): render X Article content blocks as markdown

Draft.js blocks map onto markdown, with two deliberate exceptions: a
divider produces nothing (emitting --- would read as a post boundary
downstream) and Italic is flattened.

Bold ranges are merged when adjacent and trimmed of surrounding
whitespace -- X routinely includes the trailing space in a range, and
'**bold **text' is not emphasis in CommonMark."
```

---

### Task 2: Parse the article payloads

**Files:**
- Modify: `src/adapters/twitterapi/schemas.ts`
- Test: `tests/adapters/schemas.test.ts`

**Interfaces:**
- Consumes: `ArticleBlock`, `ArticleBody`, `SourceTweet` from `src/domain/models` (Task 1).
- Produces:
  - `normalizeTweet` now sets `SourceTweet.article` (without `blocks`) when the raw tweet has one.
  - `parseArticleContents(data: unknown): ArticleBlock[]` — exported from `src/adapters/twitterapi/schemas.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/schemas.test.ts` (keep the existing `rawTweet` const and `describe` blocks):

```ts
import { parseArticleContents } from "../../src/adapters/twitterapi/schemas";

describe("normalizeTweet — articles", () => {
  it("maps the article summary that rides on a search result, without a body", () => {
    const t = normalizeTweet({
      ...rawTweet,
      text: "https://t.co/pa1EbjOsdZ",
      article: {
        title: "Phase 1: ClawHack",
        preview_text: "AI isn't just a narrative anymore.",
        cover_media_img_url: "https://pbs.twimg.com/media/HFjTzAgaQAA1DzU.jpg",
      },
    });
    expect(t.article?.title).toBe("Phase 1: ClawHack");
    expect(t.article?.previewText).toBe("AI isn't just a narrative anymore.");
    expect(t.article?.coverImageUrl).toBe("https://pbs.twimg.com/media/HFjTzAgaQAA1DzU.jpg");
    // The search response never carries the body.
    expect(t.article?.blocks).toBeUndefined();
  });

  it("leaves article undefined for an ordinary tweet, including an explicit null", () => {
    expect(normalizeTweet(rawTweet).article).toBeUndefined();
    expect(normalizeTweet({ ...rawTweet, article: null }).article).toBeUndefined();
  });
});

describe("parseArticleContents", () => {
  it("extracts the content blocks from a GET /twitter/article response", () => {
    const blocks = parseArticleContents({
      status: "success",
      msg: "success",
      article: {
        title: "Phase 1: ClawHack",
        viewCount: "90334", // a string here, a number on the tweet endpoint — must not be assumed
        contents: [
          { type: "header-two", text: "Introducing The Turing Test Hackathon" },
          { type: "unstyled", text: "Bold me", inlineStyleRanges: [{ offset: 0, length: 4, style: "Bold" }] },
          { type: "divider" },
          { type: "image", url: "https://pbs.twimg.com/media/x.jpg", width: 1280, height: 720 },
        ],
      },
    });

    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "header-two", text: "Introducing The Turing Test Hackathon" });
    expect(blocks[1].inlineStyleRanges).toEqual([{ offset: 0, length: 4, style: "Bold" }]);
    expect(blocks[2]).toEqual({ type: "divider" });
    expect(blocks[3].url).toBe("https://pbs.twimg.com/media/x.jpg");
  });

  it("returns an empty array when the response has no article or no contents", () => {
    expect(parseArticleContents({ status: "error", msg: "not found", article: null })).toEqual([]);
    expect(parseArticleContents({ article: { title: "t" } })).toEqual([]);
  });

  it("skips a malformed block instead of rejecting the whole article", () => {
    const blocks = parseArticleContents({
      article: { contents: [{ type: "unstyled", text: "kept" }, { text: "no type" }, { type: "unstyled", text: "also kept" }] },
    });
    expect(blocks.map((b) => b.text)).toEqual(["kept", "also kept"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/adapters/schemas.test.ts`
Expected: FAIL — `parseArticleContents` is not exported, and `t.article` is undefined in the first test.

- [ ] **Step 3: Write the implementation**

In `src/adapters/twitterapi/schemas.ts`, change the import on line 2 to add the article types:

```ts
import type { ArticleBlock, MediaItem, SourceTweet, TweetMetrics } from "../../domain/models";
```

Add these schemas after the `MediaRaw` const:

```ts
const InlineStyleRangeRaw = z.object({
  offset: z.number(),
  length: z.number(),
  style: z.string(),
});

/** One Draft.js content block. Passthrough so an unrecognised key never fails an article. */
const ArticleBlockRaw = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    inlineStyleRanges: z.array(InlineStyleRangeRaw).optional(),
    url: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  })
  .passthrough();

/**
 * The article summary attached to a search-result tweet. It carries a title, a ~200-character
 * excerpt and a cover image — never the body, which needs GET /twitter/article.
 */
const ArticleSummaryRaw = z
  .object({
    title: z.string(),
    preview_text: z.string().optional(),
    cover_media_img_url: z.string().optional(),
  })
  .passthrough();

/**
 * GET /twitter/article. Only `contents` is read: the rest of the payload duplicates the tweet
 * with different types (e.g. `viewCount` is a string here and a number on the tweet endpoint),
 * so nothing else is worth binding to.
 */
const ArticleResponse = z.object({
  article: z.object({ contents: z.array(z.unknown()).nullish() }).passthrough().nullish(),
});
```

Add `article` to `TweetRaw`, after the `extendedEntities` line:

```ts
    article: ArticleSummaryRaw.nullish(),
```

Add this converter next to `toMedia`:

```ts
function toArticle(raw: z.infer<typeof TweetRaw>) {
  if (!raw.article) return undefined;
  return {
    title: raw.article.title,
    previewText: raw.article.preview_text,
    coverImageUrl: raw.article.cover_media_img_url,
    // blocks stay undefined: the body arrives from a separate call (see CollectAuthoredContent).
  };
}
```

In `normalizeTweet`'s returned object, add after `media: toMedia(t),`:

```ts
    article: toArticle(t),
```

Add the exported parser at the end of the file:

```ts
/**
 * Validate a GET /twitter/article payload and return its content blocks. A block that fails
 * validation is skipped with a warning rather than rejecting the article, mirroring how
 * `TwitterApiSourceGateway.normalizeOrSkip` treats a malformed tweet.
 */
export function parseArticleContents(data: unknown): ArticleBlock[] {
  const parsed = ArticleResponse.parse(data);
  const blocks: ArticleBlock[] = [];
  for (const raw of parsed.article?.contents ?? []) {
    const result = ArticleBlockRaw.safeParse(raw);
    if (!result.success) {
      console.warn(`[twitterapi] skipping malformed article block: ${result.error.message}`);
      continue;
    }
    const { type, text, inlineStyleRanges, url, width, height } = result.data;
    blocks.push({ type, text, inlineStyleRanges, url, width, height });
  }
  return blocks;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/adapters/schemas.test.ts`
Expected: PASS.

Note: `blocks[0]` is asserted with `toEqual({ type, text })`, so the implementation must not add `undefined`-valued keys in a way that breaks strict equality. `toEqual` ignores `undefined` properties, so the destructured push above is correct as written — do not switch to `toStrictEqual`.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass; typecheck silent.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/twitterapi/schemas.ts tests/adapters/schemas.test.ts
git commit -m "feat(twitterapi): parse the article summary and content blocks

normalizeTweet now carries an article's title, preview and cover image
off the search response; parseArticleContents reads the block array from
GET /twitter/article and skips a malformed block rather than failing the
whole article."
```

---

### Task 3: `fetchArticle` on the source gateway

**Files:**
- Modify: `src/ports/SourceGateway.ts`
- Modify: `src/adapters/twitterapi/TwitterApiSourceGateway.ts`
- Test: `tests/adapters/twitterApiSourceGateway.test.ts`
- Modify (fakes must satisfy the widened port): `tests/app/collectAuthoredContent.test.ts`, `tests/app/reconcileDeletions.test.ts`

**Interfaces:**
- Consumes: `parseArticleContents` (Task 2), `ArticleBlock` (Task 1).
- Produces: `SourceGateway.fetchArticle(tweetId: string): Promise<ArticleBlock[]>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/twitterApiSourceGateway.test.ts`, inside the existing `describe("TwitterApiSourceGateway", …)`:

```ts
  it("fetchArticle calls /twitter/article with a snake_case tweet_id and returns the blocks", async () => {
    const http = new FakeHttpClient(() => ({
      status: "success",
      article: { title: "T", contents: [{ type: "header-one", text: "Hello" }, { type: "divider" }] },
    }));
    const gw = new TwitterApiSourceGateway(http);

    const blocks = await gw.fetchArticle("2042617042537451733");

    expect(http.calls).toEqual([
      { path: "/twitter/article", params: { tweet_id: "2042617042537451733" } },
    ]);
    expect(blocks).toEqual([{ type: "header-one", text: "Hello" }, { type: "divider" }]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/adapters/twitterApiSourceGateway.test.ts`
Expected: FAIL — `gw.fetchArticle is not a function`.

- [ ] **Step 3: Widen the port**

In `src/ports/SourceGateway.ts`, change the import and add the method:

```ts
import type { ArticleBlock, SourceTweet } from "../domain/models";
```

```ts
  /**
   * Body blocks for an X Article tweet. The search response marks a tweet as an article but never
   * includes its body, so this is a second call per article. Returns [] for a tweet that is not
   * an article.
   */
  fetchArticle(tweetId: string): Promise<ArticleBlock[]>;
```

- [ ] **Step 4: Implement it on the adapter**

In `src/adapters/twitterapi/TwitterApiSourceGateway.ts`, change the imports:

```ts
import type { ArticleBlock, SourceTweet } from "../../domain/models";
import { normalizeTweet, parseArticleContents, parseTweetList } from "./schemas";
```

and add the method after `fetchByIds`:

```ts
  async fetchArticle(tweetId: string): Promise<ArticleBlock[]> {
    const data = await this.client.get<unknown>("/twitter/article", { tweet_id: tweetId });
    return parseArticleContents(data);
  }
```

- [ ] **Step 5: Update the two test fakes**

In `tests/app/collectAuthoredContent.test.ts`, add to `class FakeGateway implements SourceGateway`, and add the import for `ArticleBlock`:

```ts
import type { ArticleBlock, CollectedThread, SourceTweet } from "../../src/domain/models";
```

```ts
  public articleCalls: string[] = [];
  public articles: Record<string, ArticleBlock[]> = {};
  public articleError: Error | undefined;
  async fetchArticle(tweetId: string): Promise<ArticleBlock[]> {
    this.articleCalls.push(tweetId);
    if (this.articleError) throw this.articleError;
    return this.articles[tweetId] ?? [];
  }
```

In `tests/app/reconcileDeletions.test.ts`, add to its `class FakeGateway implements SourceGateway`:

```ts
  async fetchArticle(): Promise<[]> {
    return [];
  }
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests pass. If typecheck reports another class missing `fetchArticle`, add the same two-line stub there — grep with `grep -rn "implements SourceGateway" src tests`.

- [ ] **Step 7: Commit**

```bash
git add src/ports/SourceGateway.ts src/adapters/twitterapi/TwitterApiSourceGateway.ts tests/
git commit -m "feat(twitterapi): fetchArticle on the source gateway

GET /twitter/article?tweet_id= returns an article's content blocks. The
parameter is snake_case while the rest of the tweet endpoints use camel,
which the test pins."
```

---

### Task 4: Fill article bodies during collection

**Files:**
- Modify: `src/app/CollectAuthoredContent.ts`
- Test: `tests/app/collectAuthoredContent.test.ts`

**Interfaces:**
- Consumes: `SourceGateway.fetchArticle` (Task 3), `SourceTweet.article` (Task 1).
- Produces: nothing new to later tasks — `output/x/items.json` now stores `tweets[].article.blocks`.

- [ ] **Step 1: Teach the `tw()` helper to carry an article**

`tests/app/collectAuthoredContent.test.ts`'s `tw()` helper takes a `Partial<SourceTweet>` but copies
fields **one by one** rather than spreading, so an `article` passed in today is silently dropped.
Add the field explicitly, after `isQuote: false,`:

```ts
    article: over.article,
```

- [ ] **Step 2: Write the failing tests**

Add to the same file, inside `describe("CollectAuthoredContent", …)`. The use-case's fifth
constructor argument (the clock) is optional, so the four-argument form below is valid.

```ts
  it("fetches the body for an article tweet exactly once and stores the blocks", async () => {
    const gw = new FakeGateway([tw("1", { article: { title: "Phase 1: ClawHack" } }), tw("2")]);
    gw.articles["1"] = [{ type: "unstyled", text: "Body" }];
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["1"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Body" }]);
  });

  it("makes no article call when nothing is an article", async () => {
    const gw = new FakeGateway([tw("1"), tw("2")]);
    const uc = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual([]);
  });

  it("completes the collect when an article body fetch fails", async () => {
    const gw = new FakeGateway([tw("1", { article: { title: "T" } }), tw("2")]);
    gw.articleError = new Error("HTTP 500");
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    const result = await uc.run("Mantle_Official");

    expect(result.threadCount).toBe(2);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "1");
    expect(stored?.article?.title).toBe("T");
    expect(stored?.article?.blocks).toBeUndefined();
  });

  it("fetches the body for an article pulled in by thread gap-filling", async () => {
    // The root is absent from the authored page, so gapFillMissingRoots adds it — and it is
    // itself an article. This pins that the article pass runs after gap-filling, not before.
    const reply = tw("11", { conversationId: "10", isReply: true });
    const root = tw("10", { article: { title: "Root article" } });
    const gw = new FakeGateway([reply], { "10": [root] });
    gw.articles["10"] = [{ type: "unstyled", text: "Root body" }];
    const repo = new InMemoryRepo();
    const uc = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger());

    await uc.run("Mantle_Official");

    expect(gw.articleCalls).toEqual(["10"]);
    const stored = repo.saved.flatMap((t) => t.tweets).find((t) => t.id === "10");
    expect(stored?.article?.blocks).toEqual([{ type: "unstyled", text: "Root body" }]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test tests/app/collectAuthoredContent.test.ts`
Expected: FAIL — `gw.articleCalls` is `[]` where `["1"]` is expected.

- [ ] **Step 4: Write the implementation**

In `src/app/CollectAuthoredContent.ts`, add the call directly after the existing gap-fill on line 44:

```ts
    await this.gapFillMissingRoots(fetched, userName);
    await this.fillArticleBodies(fetched);
```

and add the method immediately after `gapFillMissingRoots`:

```ts
  /**
   * Fetch each X Article's body. The search response marks a tweet as an article and gives its
   * title and a truncated preview, but the body needs one call per article — without it the
   * tweet's own `text` is a bare t.co link and the whole article is lost.
   *
   * Runs after gap-filling, because a root pulled in by `gapFillMissingRoots` can itself be an
   * article. A failure is per-tweet: the article keeps its title and loses its body rather than
   * aborting the collect, mirroring the gateway's `normalizeOrSkip`.
   */
  private async fillArticleBodies(tweets: SourceTweet[]): Promise<void> {
    for (const t of tweets) {
      if (!t.article || t.article.blocks) continue;
      try {
        const blocks = await this.source.fetchArticle(t.id);
        if (blocks.length === 0) {
          console.warn(`[collect] article ${t.id} returned no content blocks — keeping link only`);
          continue;
        }
        t.article = { ...t.article, blocks };
      } catch (err) {
        console.warn(
          `[collect] article body fetch failed for ${t.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/app/collectAuthoredContent.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/CollectAuthoredContent.ts tests/app/collectAuthoredContent.test.ts
git commit -m "feat(collect): fetch X Article bodies during collection

An article tweet's own text is a bare t.co link, so the body needs one
extra call each. Runs after gap-filling, since a gap-filled root can be
an article too, and a failure costs that article its body rather than
aborting the run."
```

---

### Task 5: Feed the rendered article into the translation queue

**Files:**
- Modify: `src/domain/translation/contentItem.ts`
- Modify: `src/adapters/content/XContentSource.ts`
- Test: `tests/adapters/content/contentSources.test.ts`

**Interfaces:**
- Consumes: `renderArticle` (Task 1), `SourceTweet.article` (Task 1).
- Produces: `ContentItem.kind?: "post" | "article"`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapters/content/contentSources.test.ts`, inside `describe("XContentSource", …)`:

```ts
  it("renders an article body as markdown and marks the item as an article", async () => {
    const items = [
      {
        rootId: "300",
        status: "active",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          {
            id: "300", conversationId: "300", text: "https://t.co/pa1EbjOsdZ",
            createdAt: "2026-01-01T00:01:00.000Z", url: "u/300",
            authorUserName: "Mantle_Official", isReply: false, isQuote: false,
            article: {
              title: "Phase 1: ClawHack",
              blocks: [
                { type: "header-two", text: "Section" },
                { type: "divider" },
                { type: "unstyled", text: "Body copy." },
              ],
            },
          },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe("article");
    expect(pending[0].text).toBe("# Phase 1: ClawHack\n\n## Section\n\nBody copy.");
    // The bare t.co link the tweet carried must not be what we translate.
    expect(pending[0].text).not.toContain("t.co");
  });

  it("marks an ordinary thread as a post and leaves its text untouched", async () => {
    const items = [
      {
        rootId: "400", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "400", conversationId: "400", text: "Plain", createdAt: "2026-01-01T00:01:00.000Z", url: "u/400", authorUserName: "Mantle_Official", isReply: false, isQuote: false },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending[0].kind).toBe("post");
    expect(pending[0].text).toBe("Plain");
  });

  it("falls back to the tweet text when an article has no fetched body", async () => {
    const items = [
      {
        rootId: "500", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "500", conversationId: "500", text: "https://t.co/abc", createdAt: "2026-01-01T00:01:00.000Z", url: "u/500", authorUserName: "Mantle_Official", isReply: false, isQuote: false, article: { title: "No body" } },
        ],
      },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set());

    expect(pending[0].kind).toBe("post");
    expect(pending[0].text).toBe("https://t.co/abc");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/adapters/content/contentSources.test.ts`
Expected: FAIL — `pending[0].kind` is `undefined` and the text is the t.co link.

- [ ] **Step 3: Add the discriminator to `ContentItem`**

Replace `src/domain/translation/contentItem.ts` with:

```ts
export interface ContentItem {
  id: string; // "x:<rootId>" | "lark:<messageId>"
  source: "x" | "lark";
  text: string; // source text to translate
  createdAt: string; // ISO
  refUrl?: string;
  /**
   * X only. An Article's text is markdown running to thousands of characters, where a post is
   * plain text under 280 — reviewers need to tell them apart in one queue. Undefined for Lark.
   */
  kind?: "post" | "article";
}
```

- [ ] **Step 4: Render articles in `XContentSource`**

In `src/adapters/content/XContentSource.ts`, add the import:

```ts
import { renderArticle } from "../../domain/articleMarkdown";
```

and replace the `items.push({...})` call in `loadPending` with:

```ts
      // A tweet with a fetched article body renders as markdown; everything else keeps its own
      // text. Handling it per tweet rather than per thread means a thread mixing the two still
      // reads correctly, and an article whose body fetch failed simply falls back to its link.
      const hasArticle = thread.tweets.some((t) => t.article?.blocks?.length);
      items.push({
        id,
        source: "x",
        text: thread.tweets
          .map((t) => (t.article?.blocks?.length ? renderArticle(t.article) : t.text))
          .join(THREAD_TWEET_SEPARATOR),
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
        kind: hasArticle ? "article" : "post",
      });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/adapters/content/contentSources.test.ts`
Expected: PASS, including the pre-existing thread-separator test.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`
Expected: all pass. `kind` is optional, so no dashboard type breaks.

- [ ] **Step 7: Commit**

```bash
git add src/domain/translation/contentItem.ts src/adapters/content/XContentSource.ts tests/adapters/content/contentSources.test.ts
git commit -m "feat(translate): put an article's rendered body in the queue

An article tweet used to enter translation as the bare t.co link it
carries. It now renders to markdown, and ContentItem.kind lets a
reviewer tell a 12,000-character article from a 280-character post."
```

---

### Task 6: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/ko/capabilities.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing.

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added`, insert as the **first** bullet:

```markdown
- **X Article bodies are collected.** `advanced_search` has always returned X Articles inside a
  normal `from:<user>` result, but their tweet `text` is a bare t.co link — a 12,000-character
  report entered the translation queue as one URL, silently. `SourceTweet` now carries an optional
  `article`, `CollectAuthoredContent` fetches each body via `GET /twitter/article?tweet_id=` (one
  call per article, after thread gap-filling), and `XContentSource` renders the Draft.js content
  blocks to markdown. `ContentItem.kind` (`"post"` / `"article"`) distinguishes them in the review
  queue. A `divider` block is deliberately **not** rendered as `---`, which `toCanonical` would read
  as a post boundary; `Italic` is flattened. Conversion (§5) and channel formatting (§6) are
  unchanged and still assume post-shaped input — see
  `docs/superpowers/specs/2026-07-23-x-article-support-design.md`.
```

- [ ] **Step 2: Update the Korean capability table**

In `docs/ko/capabilities.md`, replace the description cell of the **A. X 데이터 수집** row (line ~125) so it reads:

```markdown
| **A. X 데이터 수집** | twitterapi.io로 지정한 계정의 트윗을 스레드 단위로 재구성해 증분 수집하고, 삭제된 트윗을 소프트 마크로 반영. X 아티클은 본문(Draft.js 블록)을 별도로 받아 마크다운으로 변환 | `pnpm collect [handle]`, `pnpm reconcile` | — |
```

And in the source list around line 58, replace the X bullet with:

```markdown
- X (트위터) — 지정한 계정의 게시물을 스레드 단위로 재구성해 수집. **X 아티클은 본문까지 받아
  마크다운으로 변환합니다** (게시물 본문이 링크 한 줄만 들어오던 문제를 해결) (`pnpm collect`)
```

- [ ] **Step 3: Verify the docs reference a spec that exists**

Run: `ls docs/superpowers/specs/2026-07-23-x-article-support-design.md`
Expected: the path prints (no "No such file").

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ko/capabilities.md
git commit -m "docs: record X Article collection"
```

---

## Verification before opening the PR

- [ ] `pnpm test` — full suite green (499 tests before this work, plus ~25 new).
- [ ] `pnpm typecheck` and `pnpm typecheck:web` — both silent.
- [ ] **Live check** against a real article, since none of the above touches the network:
  ```bash
  pnpm collect Mantle_Official --since 2026-04-09 --limit 5
  ```
  `--since`/`--limit` make the run ad-hoc, so **the stored watermark is not advanced** and the
  normal incremental collect is unaffected. `2026-04-09` sits just before the ClawHack article
  (posted 2026-04-10, tweet `2042617042537451733`).
- [ ] Confirm the body landed rather than the link:
  ```bash
  node -e "const t=require('./output/x/items.json').flatMap(x=>x.tweets).find(t=>t.id==='2042617042537451733'); console.log(t.article.title, '| blocks:', t.article.blocks.length)"
  ```
  Expected: `Phase 1: ClawHack, The Turing Test Hackathon Begins | blocks: 77`
- [ ] `pnpm translate:prepare` and confirm the worksheet holds markdown headings, not a t.co link.
- [ ] Open a PR to `main` (branch protection requires the `test` CI job).
