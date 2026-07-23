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
 * A rendered line consisting entirely of 3+ hyphens reads, downstream, exactly like the pipeline's
 * `---` thread/post-boundary separator (`toCanonical` in `domain/formatting/canonical.ts`). No
 * block in the 900-block sample this design was measured against renders this way, but the guard
 * against emitting `---` above only excludes the `divider` block *type* — a block of any other type
 * (e.g. `unstyled`) whose own *text* happens to be `"---"` would still produce a lone separator
 * line. This catches that case regardless of which block produced it.
 */
const SEPARATOR_LINE = /^[ \t]*-{3,}[ \t]*$/gm;

function neutralizeSeparatorLines(text: string): string {
  return text.replace(SEPARATOR_LINE, (line) => line.replace(/-/g, "\\-"));
}

/**
 * Combine Bold ranges that touch or overlap. Without this, two adjacent ranges render as
 * `**a****b**`, whose middle `****` is not valid emphasis.
 *
 * Out-of-range entries are filtered out *before* merging, not after: merging first and rejecting
 * malformed ranges afterward can fold a valid range into an invalid one (e.g. offset -2 merging
 * with an adjacent, in-range offset 1), producing a single negative-offset range that then gets
 * dropped whole — losing the legitimate bold along with the malformed one.
 */
function mergeBoldRanges(text: string, ranges: InlineStyleRange[]): { offset: number; length: number }[] {
  const ascending = ranges
    .filter((r) => r.style === "Bold" && r.length > 0 && r.offset >= 0 && r.offset + r.length <= text.length)
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
  for (const raw of mergeBoldRanges(text, ranges).reverse()) {
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
  const rendered = pieces
    .map((piece, i) => {
      if (i === 0) return piece.text;
      const prev = pieces[i - 1];
      const sameList = prev.kind !== "block" && prev.kind === piece.kind;
      return (sameList ? "\n" : "\n\n") + piece.text;
    })
    .join("");
  return neutralizeSeparatorLines(rendered);
}
