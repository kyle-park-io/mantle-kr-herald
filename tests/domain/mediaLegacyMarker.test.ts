import { describe, expect, it } from "vitest";
import { extractMedia, stripMedia } from "../../src/domain/media/sourceMedia";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";

/**
 * The send path reads photo urls back out of the reviewed text. Nothing re-derives that text on
 * read, so every translation and rendering saved before the `[사진](url)` label existed still holds
 * the old `![](url)` spelling — and must still yield its photo and still be stripped from the body.
 * Without this, an older approved item would post with a literal `![](https://…)` in the tweet and
 * no image attached.
 */
describe("photo marker spellings", () => {
  it("extracts the url from the labelled form", () => {
    expect(extractMedia(`본문\n\n[사진](${URL})`)).toEqual({ text: "본문", photos: [URL], videos: [] });
  });

  it("extracts the url from the legacy empty-alt form", () => {
    expect(extractMedia(`본문\n\n![](${URL})`)).toEqual({ text: "본문", photos: [URL], videos: [] });
  });

  it("strips either spelling out of the body a destination emits", () => {
    expect(stripMedia(`본문\n\n[사진](${URL})`)).toBe("본문");
    expect(stripMedia(`본문\n\n![](${URL})`)).toBe("본문");
  });

  it("leaves an inline link alone — only a marker on its own line is media", () => {
    // `[사진](url)` is a markdown link by shape, so the line-anchored match is what keeps a
    // sentence that happens to mention one from being eaten as an attachment.
    const inline = `자세한 내용은 [사진](${URL})에서 확인할 수 있습니다`;
    expect(extractMedia(inline)).toEqual({ text: inline, photos: [], videos: [] });
  });
});
