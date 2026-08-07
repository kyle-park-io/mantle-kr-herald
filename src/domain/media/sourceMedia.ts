/**
 * Media surfaced in the source text as canonical markers, plus the send-time extraction that
 * reverses it. A post's photos/videos live in items.json, but the pipeline's single source of truth
 * is the reviewed text: XContentSource writes these markers into the source, they stay visible
 * through translation/convert/format (stored in rendering.text), and the send reads them back here.
 */

/**
 * A photo marker alone on its line. Two spellings, both matched:
 *
 *   `[사진](url)`  — what the pipeline writes now. Labelled like `[영상]`, so a reviewer reads what
 *                    the line *is* before reading a 60-character CDN url.
 *   `![](url)`     — the original empty-alt markdown image, still matched so every translation and
 *                    rendering saved before the change keeps working. Nothing re-derives stored
 *                    text on read, so dropping this would strand them.
 *
 * The label form is a markdown link, which `linksToPlain`'s `MD_LINK` would happily rewrite — but it
 * never sees one: `emit()` calls `stripMedia` before any destination emitter runs
 * (`emitters/index.ts`), so the marker line is gone by then. (`[영상]` is paren-free on the theory
 * that it had to dodge `MD_LINK`; given that ordering, it never did.)
 */
const PHOTO_LINE = /^(?:\[사진\]|!\[\])\(([^)]+)\)[ \t]*$/;
/** A video marker alone on its line: `[영상]`, optionally followed by a bare url (the follow-up puts
 *  the mp4 there; this cycle it has none). Paren-free so linksToPlain's MD_LINK never rewrites it. */
const VIDEO_LINE = /^\[영상\](?:[ \t]+(\S+))?[ \t]*$/;

export interface ExtractedMedia {
  /** The text with every marker line removed (and the blank line each one sat behind). */
  text: string;
  /** Photo urls, in document order. */
  photos: string[];
  /** One entry per `[영상]` marker — its url, or "" when it has none (this cycle: always ""). */
  videos: string[];
}

export function extractMedia(text: string): ExtractedMedia {
  const photos: string[] = [];
  const videos: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const photo = PHOTO_LINE.exec(line);
    if (photo) {
      photos.push(photo[1]);
      if (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop(); // drop the \n\n it sat behind
      continue;
    }
    const video = VIDEO_LINE.exec(line);
    if (video) {
      videos.push(video[1] ?? "");
      if (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
      continue;
    }
    kept.push(line);
  }
  // Only edge blank lines are trimmed; interior runs (incl. X's \n\n\n post boundaries) stay as-is.
  return { text: kept.join("\n").replace(/^\n+|\n+$/g, ""), photos, videos };
}

export function stripMedia(text: string): string {
  return extractMedia(text).text;
}

/**
 * Rewrite every legacy `![](url)` marker line back to the canonical `[사진](url)`, and say how many
 * were rewritten.
 *
 * Every reader here takes both spellings (`PHOTO_LINE` above, `web/src/media.ts`'s own copy,
 * `ARTICLE_IMAGE` in domain/publish/articleMarkdown.ts), so this changes nothing about what the
 * pipeline *can* do. What it protects is the label's only reason to exist: a reviewer reading
 * `[사진]` and knowing what the line is without parsing a CDN url. The translating agent drops that
 * label — 8 of 8 photo-carrying items in one production batch on 2026-08-07, against sources that
 * all carried it — so the source's spelling is restored here rather than hoped for in a prompt.
 *
 * Line-anchored, exactly like `PHOTO_LINE`: an inline `![](url)` inside a sentence is not a media
 * marker, and an `![alt](url)` with real alt text is a caption. Neither is this function's business,
 * and `ARTICLE_IMAGE` embeds an article's inline images either way.
 *
 * `changed` is returned rather than logged so the caller decides what to do with it — see
 * `SaveTranslation.run`, which surfaces it, and `checkGlossary`'s doc comment for the same
 * report-don't-throw reasoning: this is drift worth seeing, never a reason to refuse a save.
 */
export function normalizePhotoMarkers(text: string): { text: string; changed: number } {
  let changed = 0;
  const lines = text.split("\n").map((line) => {
    const photo = PHOTO_LINE.exec(line);
    if (!photo || line.startsWith("[사진]")) return line;
    changed++;
    return `[사진](${photo[1]})`;
  });
  return { text: changed === 0 ? text : lines.join("\n"), changed };
}
