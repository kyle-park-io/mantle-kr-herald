/**
 * Media surfaced in the source text as canonical markers, plus the send-time extraction that
 * reverses it. A post's photos/videos live in items.json, but the pipeline's single source of truth
 * is the reviewed text: XContentSource writes these markers into the source, they stay visible
 * through translation/convert/format (stored in rendering.text), and the send reads them back here.
 */

/** An empty-alt markdown image alone on its line — the exact form renderArticle emits for an
 *  article's inline images, so a photo looks identical in a post and an article. */
const PHOTO_LINE = /^!\[\]\(([^)]+)\)[ \t]*$/;
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
