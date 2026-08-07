import { describe, expect, it } from "vitest";
import { normalizePhotoMarkers } from "../../src/domain/media/sourceMedia";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";

/**
 * The label `[사진](url)` exists so a reviewer reads what a line *is* before reading a 60-character
 * CDN url, and `XContentSource` has written nothing else since it was introduced. The translating
 * agent, however, rewrites it: measured against production on 2026-08-07, 8 of 8 photo-carrying
 * translations in one batch came back with `![](url)` while their sources all held `[사진](url)`.
 * Nothing in the prompt asked for that and nothing caught it, because every reader accepts both.
 *
 * So the label is restored on the way in, at the one write path every translation passes through.
 */
describe("normalizePhotoMarkers", () => {
  it("restores the label on a legacy marker line", () => {
    expect(normalizePhotoMarkers(`본문\n\n![](${URL})`)).toEqual({ text: `본문\n\n[사진](${URL})`, changed: 1 });
  });

  it("reports nothing changed when the text already uses the label", () => {
    const text = `본문\n\n[사진](${URL})`;
    expect(normalizePhotoMarkers(text)).toEqual({ text, changed: 0 });
  });

  it("counts every marker it restores", () => {
    const { changed } = normalizePhotoMarkers(`![](${URL})\n\n본문\n\n![](${URL})`);
    expect(changed).toBe(2);
  });

  it("leaves an inline image alone — only a marker on its own line is media", () => {
    // Same boundary `extractMedia` draws (see mediaLegacyMarker.test.ts). An article body's inline
    // image is not a media marker, and rewriting it would change prose this has no business
    // touching — `ARTICLE_IMAGE` reads both spellings anyway, so nothing downstream needs it.
    const inline = `자세한 내용은 ![](${URL}) 에서 확인할 수 있습니다`;
    expect(normalizePhotoMarkers(inline)).toEqual({ text: inline, changed: 0 });
  });

  it("leaves an image with alt text alone", () => {
    // `![alt](url)` is a deliberate caption, not the empty-alt marker the pipeline emits, and
    // PHOTO_LINE has never matched it either.
    const text = `![차트](${URL})`;
    expect(normalizePhotoMarkers(text)).toEqual({ text, changed: 0 });
  });

  it("leaves a video marker and ordinary text untouched", () => {
    const text = "본문\n\n[영상]\n\n더 본문";
    expect(normalizePhotoMarkers(text)).toEqual({ text, changed: 0 });
  });

  it("preserves trailing whitespace handling of the marker line", () => {
    // PHOTO_LINE tolerates trailing spaces/tabs, so the normalizer must recognise the same line.
    expect(normalizePhotoMarkers(`![](${URL})  `)).toEqual({ text: `[사진](${URL})`, changed: 1 });
  });
});
