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

export type MediaSegment =
  | { kind: "text"; text: string }
  | { kind: "photo"; text: string; url: string };

/**
 * Split stored text into runs of ordinary text and the photo markers between them.
 *
 * Segments are line-aligned, so rejoining them with a single newline reproduces the input exactly —
 * that invariant is what lets the renderer show the reviewed text unchanged.
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
    buffer.push(line);
  }
  flush();
  return segments;
}

/** How much media the text carries, by kind. Only photos can be previewed. */
export function countMediaMarkers(text: string): { photos: number; videos: number } {
  let photos = 0;
  let videos = 0;
  for (const line of text.split("\n")) {
    if (PHOTO_LINE.test(line)) photos += 1;
    else if (VIDEO_LINE.test(line)) videos += 1;
  }
  return { photos, videos };
}
