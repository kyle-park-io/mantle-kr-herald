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
