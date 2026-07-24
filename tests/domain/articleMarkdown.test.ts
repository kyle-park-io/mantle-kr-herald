import { describe, it, expect } from "vitest";
import { renderArticle } from "../../src/domain/articleMarkdown";
import { toCanonical, splitPosts } from "../../src/domain/formatting/canonical";
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

  it("drops a block whose own text is a lone hyphen line, not just a divider", () => {
    // The divider guard above excludes the `divider` block *type*; this covers any other block
    // (here `unstyled`) whose rendered text happens to be a bare "---" line, which would otherwise
    // read as toCanonical's post-boundary separator. Dropped whole, exactly like `divider` — not
    // escaped: an escaped `\-\-\-` would survive into `Translation.sourceText` and leak literal
    // backslashes into a Lark/Telegram message, which never unescapes it.
    const out = renderArticle({
      title: "",
      blocks: [{ type: "unstyled", text: "a" }, { type: "unstyled", text: "---" }, { type: "unstyled", text: "b" }],
    });
    expect(out).toBe("a\n\nb");
    expect(out).not.toContain("\\-");

    // Confirm the central invariant end to end: toCanonical must not read it as a post boundary.
    expect(splitPosts(toCanonical(out))).toHaveLength(1);
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

  it("filters an out-of-range bold entry before merging, instead of losing an adjacent valid one", () => {
    // A negative-offset range merging with a valid adjacent one (old behaviour: merge first, then
    // reject) used to fold the two into one negative-offset range and drop it whole, losing the
    // legitimate bold along with the malformed one.
    const out = renderArticle({
      title: "",
      blocks: [
        {
          type: "unstyled",
          text: "abcdef",
          inlineStyleRanges: [
            { offset: -2, length: 3, style: "Bold" },
            { offset: 1, length: 3, style: "Bold" },
          ],
        },
      ],
    });
    expect(out).toBe("a**bcd**ef");
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
