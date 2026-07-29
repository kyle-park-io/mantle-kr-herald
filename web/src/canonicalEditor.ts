/**
 * The canonical post boundary is *two blank lines*, which in a textarea is one keystroke away from
 * the single blank line between paragraphs and looks like nothing at all. So the editor shows it as
 * a `---` rule instead — visible, deliberate, and the same spelling the source arrives in.
 *
 * A display transform only. Nothing about storage or delivery changes: `toCanonical` on the server
 * already reads a lone `---` line as a boundary (both `SaveRendering` and, since this change,
 * `SaveOutletOverride`), so the text typed here round-trips back to blank lines untouched. Keeping
 * `---` in the stored text instead would put it in front of every emitter, and a single missed
 * strip is a literal separator in a live post — the bug this pipeline already shipped once.
 */
const BOUNDARY = "\n\n\n";
const SHOWN = "\n\n---\n\n";

/** Stored canonical → what the reviewer edits. */
export const toEditor = (canonical: string): string => canonical.split(BOUNDARY).join(SHOWN);

/**
 * What the reviewer edits → canonical, for comparing against what is stored.
 *
 * Only used to answer "has this been edited"; the server re-canonicalises on save and is the
 * authority. Any `---` line counts, not just the ones this module wrote, because that is what
 * `toCanonical` will do with them.
 */
export const fromEditor = (shown: string): string =>
  shown.replace(/\n[ \t]*\n[ \t]*-{3,}[ \t]*\n[ \t]*\n/g, BOUNDARY);
