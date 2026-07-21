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
export const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Two blank lines. Written out because the whole file turns on this being exactly three \n. */
const POST_BOUNDARY = "\n\n\n";

/**
 * Normalise text into canonical form. Channel-independent by definition.
 *
 * Note the blank-line rule differs from the pre-canonical formatter, which collapsed 3+ newlines
 * to 2 and would therefore have destroyed every post boundary.
 */
export function toCanonical(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, POST_BOUNDARY).trim();
}

/** Split canonical text on post boundaries. Always returns at least one entry. */
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
