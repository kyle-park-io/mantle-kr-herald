/**
 * Media markers as they appear in the reviewed text. `XContentSource.mediaMarkers()` writes them,
 * `emit()` strips them (`stripMedia`), and the send path reads the photo urls back out — so the text
 * on these screens is the only place a reviewer can see that a post carries media.
 *
 * These two patterns MIRROR `PHOTO_LINE`/`VIDEO_LINE` in `src/domain/media/sourceMedia.ts` and must
 * be changed together. The frontend cannot import them: `src/` is a Node pipeline typechecked without
 * the DOM lib, and `web/` builds on its own tsconfig. A looser pattern here would preview something
 * the send path does not treat as media, which is worse than not previewing at all.
 */
const PHOTO_LINE = /^(?:\[사진\]|!\[\])\(([^)]+)\)[ \t]*$/;
const VIDEO_LINE = /^\[영상\](?:[ \t]+(\S+))?[ \t]*$/;

/**
 * A media segment always carries a url, so a renderer never has to ask whether there is anything to
 * show. A `[영상]` with no url is therefore NOT a video segment — see `splitMediaMarkers`.
 */
export type MediaSegment =
  | { kind: "text"; text: string }
  | { kind: "photo"; text: string; url: string }
  | { kind: "video"; text: string; url: string };

/**
 * Split stored text into runs of ordinary text and the media markers between them.
 *
 * Segments are line-aligned, so rejoining them with a single newline reproduces the input exactly —
 * that invariant is what lets the renderer show the reviewed text unchanged.
 *
 * A url-less `[영상]` stays inside a text segment rather than becoming a preview-less video segment.
 * There will always be some: `XContentSource` only started writing the mp4 url into the marker after
 * this cycle's collect change, nothing re-derives stored text on read, and every translation and
 * rendering saved before it keeps the bare marker forever. Leaving it as text is what guarantees a
 * reviewer opening one of those sees precisely what they saw yesterday — and it means no caller can
 * ever hand a `<video>` an empty `src`, which browsers resolve against the current page and load.
 */
export function splitMediaMarkers(text: string): MediaSegment[] {
  const segments: MediaSegment[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) segments.push({ kind: "text", text: buffer.join("\n") });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const photo = PHOTO_LINE.exec(line);
    if (photo) {
      flush();
      segments.push({ kind: "photo", text: line, url: photo[1] });
      continue;
    }
    const video = VIDEO_LINE.exec(line);
    if (video?.[1]) {
      flush();
      segments.push({ kind: "video", text: line, url: video[1] });
      continue;
    }
    buffer.push(line);
  }
  flush();
  return segments;
}

/**
 * How much media the text carries, by kind — plus how much of it can be previewed at all.
 *
 * A photo marker always carries its url. A video marker only carries one if it was written after the
 * collect schema started capturing the playable mp4, so `videos` and `videosWithUrl` differ on any
 * text saved before then; both spellings still count as videos, because the reviewer is being told
 * what the post contains, not what the renderer can do with it.
 */
export function countMediaMarkers(text: string): {
  photos: number;
  videos: number;
  videosWithUrl: number;
} {
  let photos = 0;
  let videos = 0;
  let videosWithUrl = 0;
  for (const line of text.split("\n")) {
    if (PHOTO_LINE.test(line)) {
      photos += 1;
      continue;
    }
    const video = VIDEO_LINE.exec(line);
    if (video) {
      videos += 1;
      if (video[1]) videosWithUrl += 1;
    }
  }
  return { photos, videos, videosWithUrl };
}
