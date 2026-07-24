/**
 * Canonical text is what `renderings.json` stores: the post's meaning, not any destination's
 * spelling. Its whole vocabulary is `**bold**`, `[text](url)`, one blank line for a paragraph
 * break, and two blank lines for a post boundary (x channel only). Emitters turn this into
 * whatever a given destination actually accepts.
 */
/**
 * Exported so emitters that rewrite these constructs match canonical's definition exactly.
 * Use them only with `String.replace`, which resets `lastIndex`; `.test()`/`.exec()` on a shared
 * /g regex carries state between calls and will skip matches.
 */
export const BOLD = /\*\*([\s\S]+?)\*\*/g;
/**
 * The URL group allows one level of balanced parens (e.g. a Wikipedia slug like
 * "Mantle_(blockchain)") so a plain `[^)]+` does not stop at the first `)` inside the URL itself
 * and truncate it. See `weightedLength`'s `BALANCED_DELIMITERS`, which treats the same URL class
 * as real for the same reason.
 *
 * The trailing `|\(` alternative additionally accepts a `(` with no matching `)` anywhere in the
 * URL (e.g. a link typed with a forgotten close-paren). Backtracking prefers the balanced
 * alternative first, so a real "(b)" pair is still consumed whole; the bare `(` only gets used
 * when no closing paren is available to pair it, which is exactly the unmatched case.
 *
 * Known limitation: true two-level nesting — a balanced pair inside another pair, e.g.
 * "x_((deep)_nested)" — is not matched correctly, since a regex (no recursion) cannot verify
 * balance more than one level deep; it reads the outer `)` of such a URL as the link's own closing
 * paren and leaves the innermost `)` unconsumed. Two *separate* balanced pairs side by side (e.g.
 * "a(b)/c(d)"), one level of nesting (the Wikipedia case), and a single unmatched `(` are all
 * unaffected and verified in canonical.test.ts. True nesting has not come up in a real link this
 * pipeline has produced; if it does, this would need a hand-rolled parser instead of one regex.
 */
export const MD_LINK = /\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\)|\()+)\)/g;

/** Two blank lines. Written out because the whole file turns on this being exactly three \n. */
const POST_BOUNDARY = "\n\n\n";

/**
 * A line whose entire content is three or more hyphens (spaces/tabs allowed around them) — `---`,
 * the pipeline's long-standing thread separator. `XContentSource` has joined collected tweets with
 * `"\n\n---\n\n"` since before canonical text existed, so it is already baked into every saved
 * translation, and it is the team's own drafting convention for marking a tweet boundary. Matching
 * per line (via `/m`) rather than as a run of hyphens anywhere keeps inline hyphens — "가---나", "단어
 * - 단어", a leading "- bullet" — untouched, since those never occupy a whole line by themselves.
 *
 * Exported so `articleMarkdown.ts`'s divider/separator guard uses this exact definition instead of
 * an independent copy. Per the caution above `BOLD`: use this only with `String.replace`, which
 * resets `lastIndex`; `.test()`/`.exec()` on a shared `/g` regex carries state between calls.
 */
export const SEPARATOR_LINE = /^[ \t]*-{3,}[ \t]*$/gm;

/**
 * Normalise text into canonical form. Channel-independent by definition.
 *
 * Note the blank-line rule differs from the pre-canonical formatter, which collapsed 3+ newlines
 * to 2 and would therefore have destroyed every post boundary.
 *
 * Only runs of bare newlines count as blank lines; a line containing whitespace breaks the run.
 * Content with trailing spaces on an intended-blank line silently loses both paragraph breaks
 * and any post-boundary meaning.
 *
 * A `---` separator line is accepted as an alternate spelling of the post boundary, along with any
 * blank lines around it (see `SEPARATOR_LINE`). Canonical text itself never contains a literal
 * `---`: this step folds it into the same `\n\n\n` boundary as two blank lines, so every downstream
 * consumer — the worksheet, emitters, `splitPosts` — only ever has one representation to handle.
 */
export function toCanonical(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(SEPARATOR_LINE, "\n\n")
    .replace(/\n{4,}/g, POST_BOUNDARY)
    .trim();
}

/**
 * Split canonical text on post boundaries. Always returns at least one entry.
 *
 * Splits on `\n{3,}` alone — it never looks for `---`. That spelling is accepted upstream, in
 * `toCanonical` (see its doc comment), so by the time text reaches `splitPosts` any `---` line
 * from the pipeline's thread separator has already become the same `\n{3,}` boundary.
 *
 * If **bold** opens before a post boundary and closes after it, this split cuts it into
 * two posts each carrying an unbalanced **, which a later per-post stripBold cannot clean up,
 * so literal asterisks leak into output. Callers that apply stripBold per-post must be aware.
 */
export function splitPosts(canonical: string): string[] {
  const parts = canonical.split(/\n{3,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [canonical.trim()];
}

/** Drop bold markers, keeping the inner text. For destinations with no formatting at all. */
export function stripBold(text: string): string {
  return text.replace(BOLD, "$1");
}

/** Rewrite `[text](url)` as `text (url)` for destinations with no link syntax. */
export function linksToPlain(text: string): string {
  return text.replace(MD_LINK, "$1 ($2)");
}

/** Keep only the label of `[text](url)` — what shows once the link becomes a native entity. */
export function linksToLabel(text: string): string {
  return text.replace(MD_LINK, "$1");
}

/** Post boundaries are an x-channel concept; every other destination reads them as a paragraph. */
export function flattenPostBoundaries(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}
