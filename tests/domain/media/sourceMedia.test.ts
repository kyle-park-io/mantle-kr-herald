import { describe, it, expect } from "vitest";
import { extractMedia, stripMedia } from "../../../src/domain/media/sourceMedia";

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
