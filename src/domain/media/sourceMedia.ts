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
/** A video marker alone on its line: `[영상]`, optionally followed by a bare url — the playable mp4
 *  `XContentSource` now captures from `video_info` (see adapters/twitterapi/schemas.ts). The url
 *  stays optional because a thread collected before that capture existed carries the bare marker,
 *  and nothing re-derives stored text on read. Paren-free so linksToPlain's MD_LINK never
 *  rewrites it — a `[영상](url)` form would be a markdown link, not a marker. */
const VIDEO_LINE = /^\[영상\](?:[ \t]+(\S+))?[ \t]*$/;

export interface ExtractedMedia {
  /** The text with every marker line removed (and the blank line each one sat behind). */
  text: string;
  /** Photo urls, in document order. */
  photos: string[];
  /** One entry per `[영상]` marker — its mp4 url, or "" for a marker collected before the url was
   *  captured. Positional either way, so a caller can still count the videos a post carries. */
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

/**
 * Every `[영상]` marker line in a text, and how many of them carry no url yet.
 *
 * Separate from `fillVideoMarkers` below because a caller sometimes has to decide *whether* a text
 * is worth reporting before it has anything to pair the markers with: `BackfillTextVideoUrls` must
 * name a bare marker whose item has no collected thread at all, and there is no url list to hand
 * `fillVideoMarkers` in that case.
 */
export function countVideoMarkers(text: string): { markers: number; bare: number } {
  let markers = 0;
  let bare = 0;
  for (const line of text.split("\n")) {
    const video = VIDEO_LINE.exec(line);
    if (!video) continue;
    markers++;
    if (!video[1]) bare++;
  }
  return { markers, bare };
}

/**
 * What `fillVideoMarkers` did, or the reason it refused. A refusal is a named outcome rather than a
 * thrown error or a silent no-op: every one of them is a text a person may have to look at, and the
 * caller reports them (see `videoBackfillReport`'s sibling, `textVideoBackfillReport`).
 */
export type VideoMarkerFill =
  /** Rewritten. `filled` bare markers gained a url; every other line is byte-identical. */
  | { status: "filled"; text: string; filled: number; markers: number }
  /** Nothing to do — the text carries no marker, or every marker already has its url. */
  | { status: "no-bare-markers"; markers: number }
  /** The text's markers and the post's videos do not correspond one-to-one. */
  | { status: "count-mismatch"; markers: number; bare: number; urls: number }
  /** They correspond, but `missing` of the videos a bare marker pairs with have no mp4 stored. */
  | { status: "url-missing"; markers: number; bare: number; missing: number };

/**
 * Fill each bare `[영상]` marker line in stored reviewed text with the mp4 url of the video it
 * stands for.
 *
 * The same mechanical rewrite of already-reviewed text that `normalizePhotoMarkers` established
 * above, and it exists for the reason stated all over this file: **nothing re-derives a stored text
 * on read**. A translation or rendering saved before `XContentSource` captured `video_info` carries
 * a url-less `[영상]` forever, however completely `x:video-backfill` has since filled the collected
 * thread it came from. And a bare marker is not cosmetic — `SendChannels` uploads only
 * `videos.filter((url) => url !== "")`, so the clip a human approved is simply not attached.
 *
 * Pairing is **by position across every marker in the text**, not across the bare ones only. In the
 * text this was written for they are the same thing (all markers are bare), but they diverge the
 * moment a post carried two videos and collection captured an mp4 for only one: the bare marker is
 * then the *second* video, and pairing it with the first would staple the wrong clip onto the post
 * — a swap nothing downstream can detect, because both urls are real mp4s. Same reasoning as
 * `BackfillVideoUrls`' match-by-thumbnail rule, one layer up.
 *
 * Refuses rather than guesses, and refuses whole texts rather than filling the unambiguous prefix.
 * A half-filled text reads as finished, so the wrong pairing it may contain would never be looked
 * at again; an untouched one still shows up in the next run's report. `urls` shorter than the marker
 * count is the obvious mismatch, but longer is just as ambiguous — a text carrying one marker for a
 * two-video post names neither clip.
 *
 * `urls` is positional and `""` means "this video has no mp4 stored" — exactly what
 * `extractMedia().videos` yields, which is where callers get it from.
 */
export function fillVideoMarkers(text: string, urls: readonly string[]): VideoMarkerFill {
  const { markers, bare } = countVideoMarkers(text);
  if (bare === 0) return { status: "no-bare-markers", markers };
  if (markers !== urls.length) return { status: "count-mismatch", markers, bare, urls: urls.length };

  // Counted before anything is rewritten: a text whose second bare marker turns out to be unfillable
  // must not come back with its first one already filled.
  let missing = 0;
  let slot = 0;
  for (const line of text.split("\n")) {
    const video = VIDEO_LINE.exec(line);
    if (!video) continue;
    // Only a slot this call would actually write. A marker that already carries a url keeps it
    // whatever the collected thread now says, so an empty url there is not this function's problem.
    if (!video[1] && urls[slot] === "") missing++;
    slot++;
  }
  if (missing > 0) return { status: "url-missing", markers, bare, missing };

  let filled = 0;
  slot = 0;
  const lines = text.split("\n").map((line) => {
    const video = VIDEO_LINE.exec(line);
    if (!video) return line;
    const url = urls[slot++];
    if (video[1]) return line;
    filled++;
    return `[영상] ${url}`;
  });
  return { status: "filled", text: lines.join("\n"), filled, markers };
}
