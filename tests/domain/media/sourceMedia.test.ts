import { describe, it, expect } from "vitest";
import { countVideoMarkers, extractMedia, fillVideoMarkers, stripMedia } from "../../../src/domain/media/sourceMedia";

describe("extractMedia", () => {
  it("extracts a photo marker and removes it with the blank line it sat behind", () => {
    expect(extractMedia("트윗 본문\n\n![](https://img/a.jpg)")).toEqual({
      text: "트윗 본문", photos: ["https://img/a.jpg"], videos: [],
    });
  });

  it("extracts multiple photos in document order", () => {
    const r = extractMedia("본문\n\n![](https://img/a.jpg)\n![](https://img/b.jpg)");
    expect(r.photos).toEqual(["https://img/a.jpg", "https://img/b.jpg"]);
    expect(r.text).toBe("본문");
  });

  it("records a url-less video marker as \"\" and removes it", () => {
    expect(extractMedia("영상 트윗\n\n[영상]")).toEqual({ text: "영상 트윗", photos: [], videos: [""] });
  });

  it("reads the mp4 back out of a `[영상] url` marker, query string and all", () => {
    const mp4 = "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/720x720/hi.mp4?tag=14";
    expect(extractMedia(`영상 트윗\n\n[영상] ${mp4}`)).toEqual({ text: "영상 트윗", photos: [], videos: [mp4] });
  });

  it("keeps document order across a url-carrying and a url-less video marker", () => {
    const mp4 = "https://video.twimg.com/amplify_video/1/vid/avc1/720x720/a.mp4";
    const r = extractMedia(`본문\n\n[영상] ${mp4}\n[영상]`);
    expect(r.videos).toEqual([mp4, ""]);
    expect(r.text).toBe("본문");
  });

  it("handles a photo and a video together", () => {
    const r = extractMedia("본문\n\n![](https://img/a.jpg)\n\n[영상]");
    expect(r.photos).toEqual(["https://img/a.jpg"]);
    expect(r.videos).toEqual([""]);
    expect(r.text).toBe("본문");
  });

  it("leaves text without markers unchanged", () => {
    expect(extractMedia("그냥 텍스트")).toEqual({ text: "그냥 텍스트", photos: [], videos: [] });
  });

  it("preserves an X post boundary (\\n\\n\\n) when a photo sits on the first tweet", () => {
    const r = extractMedia("첫 트윗\n\n![](https://img/a.jpg)\n\n\n둘째 트윗");
    expect(r.photos).toEqual(["https://img/a.jpg"]);
    expect(r.text).toBe("첫 트윗\n\n\n둘째 트윗");
  });

  it("stripMedia returns just the cleaned text", () => {
    expect(stripMedia("본문\n\n![](https://x/a.jpg)")).toBe("본문");
  });
});

const MP4_A = "https://video.twimg.com/amplify_video/1/vid/avc1/720x720/a.mp4?tag=14";
const MP4_B = "https://video.twimg.com/amplify_video/2/vid/avc1/720x720/b.mp4?tag=14";

describe("countVideoMarkers", () => {
  it("counts every marker line and how many carry no url", () => {
    expect(countVideoMarkers(`본문\n\n[영상] ${MP4_A}\n[영상]\n[영상]`)).toEqual({ markers: 3, bare: 2 });
  });

  it("counts nothing in a text with no video markers", () => {
    expect(countVideoMarkers("본문\n\n[사진](https://img/a.jpg)")).toEqual({ markers: 0, bare: 0 });
  });

  it("does not count an inline [영상] that is not alone on its line", () => {
    expect(countVideoMarkers("보도자료 [영상] 첨부합니다")).toEqual({ markers: 0, bare: 0 });
  });
});

describe("fillVideoMarkers", () => {
  it("fills a bare marker with the url of the video it stands for", () => {
    const r = fillVideoMarkers(`영상 트윗\n\n[영상]`, [MP4_A]);

    expect(r).toEqual({ status: "filled", text: `영상 트윗\n\n[영상] ${MP4_A}`, filled: 1, markers: 1 });
    // Round-trips through the reader the send path uses — the whole point of writing the url back.
    expect(extractMedia((r as { text: string }).text).videos).toEqual([MP4_A]);
  });

  it("leaves a marker that already carries a url exactly as stored", () => {
    const stored = `본문\n\n[영상] ${MP4_A}\n[영상]`;

    expect(fillVideoMarkers(stored, [MP4_A, MP4_B])).toEqual({
      status: "filled",
      text: `본문\n\n[영상] ${MP4_A}\n[영상] ${MP4_B}`,
      filled: 1,
      markers: 2,
    });
  });

  it("pairs by position across ALL markers, so a bare second marker takes the SECOND url", () => {
    // The pairing that a "Nth bare marker takes the Nth url" rule would get wrong: the bare marker
    // is the second video of the post, and filling it with the first would staple the wrong clip on.
    const r = fillVideoMarkers(`본문\n\n[영상] ${MP4_A}\n[영상]`, [MP4_A, MP4_B]);

    expect(r).toEqual({ status: "filled", text: `본문\n\n[영상] ${MP4_A}\n[영상] ${MP4_B}`, filled: 1, markers: 2 });
  });

  it("never touches a photo marker, in either spelling", () => {
    const stored = `본문\n\n[사진](https://img/a.jpg)\n![](https://img/b.jpg)\n[영상]`;

    expect(fillVideoMarkers(stored, [MP4_A])).toEqual({
      status: "filled",
      text: `본문\n\n[사진](https://img/a.jpg)\n![](https://img/b.jpg)\n[영상] ${MP4_A}`,
      filled: 1,
      markers: 1,
    });
  });

  it("reports a text with no bare marker rather than rewriting it", () => {
    const stored = `본문\n\n[영상] ${MP4_A}`;

    expect(fillVideoMarkers(stored, [MP4_A])).toEqual({ status: "no-bare-markers", markers: 1 });
  });

  it("reports a text with no markers at all as having nothing bare", () => {
    expect(fillVideoMarkers("그냥 텍스트", [])).toEqual({ status: "no-bare-markers", markers: 0 });
  });

  it("refuses when the text carries more markers than the post has videos", () => {
    expect(fillVideoMarkers("본문\n\n[영상]\n[영상]", [MP4_A])).toEqual({
      status: "count-mismatch",
      markers: 2,
      bare: 2,
      urls: 1,
    });
  });

  it("refuses when the post has more videos than the text carries markers", () => {
    // Ambiguous in the other direction: nothing says which of the two clips the one marker is.
    expect(fillVideoMarkers("본문\n\n[영상]", [MP4_A, MP4_B])).toEqual({
      status: "count-mismatch",
      markers: 1,
      bare: 1,
      urls: 2,
    });
  });

  it("refuses when the video a bare marker pairs with still has no mp4 of its own", () => {
    expect(fillVideoMarkers("본문\n\n[영상]\n[영상]", ["", MP4_B])).toEqual({
      status: "url-missing",
      markers: 2,
      bare: 2,
      missing: 1,
    });
  });

  it("ignores an empty url in a slot it was never going to write", () => {
    // Slot 1 is already filled in the stored text, so its (still empty) collected url is not this
    // function's problem — refusing here would strand a text it can fill correctly.
    expect(fillVideoMarkers(`본문\n\n[영상] ${MP4_A}\n[영상]`, ["", MP4_B])).toEqual({
      status: "filled",
      text: `본문\n\n[영상] ${MP4_A}\n[영상] ${MP4_B}`,
      filled: 1,
      markers: 2,
    });
  });

  it("is idempotent: filling the result again finds nothing bare", () => {
    const once = fillVideoMarkers("본문\n\n[영상]", [MP4_A]) as { text: string };

    expect(fillVideoMarkers(once.text, [MP4_A])).toEqual({ status: "no-bare-markers", markers: 1 });
  });

  it("keeps every other line byte-identical, blank lines and post boundaries included", () => {
    const stored = `첫 트윗\n\n[영상]\n\n\n둘째 트윗\n  들여쓴 줄  \n\n[사진](https://img/a.jpg)`;

    expect(fillVideoMarkers(stored, [MP4_A])).toMatchObject({
      text: `첫 트윗\n\n[영상] ${MP4_A}\n\n\n둘째 트윗\n  들여쓴 줄  \n\n[사진](https://img/a.jpg)`,
    });
  });
});
