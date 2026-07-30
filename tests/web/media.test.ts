import { describe, expect, it } from "vitest";
import { countMediaMarkers, splitMediaMarkers } from "../../web/src/media";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;

describe("splitMediaMarkers", () => {
  it("returns a single text segment when there is no marker", () => {
    expect(splitMediaMarkers("한 줄\n두 줄")).toEqual([{ kind: "text", text: "한 줄\n두 줄" }]);
  });

  it("splits a photo marker out of the text around it", () => {
    expect(splitMediaMarkers(`본문\n\n${PHOTO}`)).toEqual([
      { kind: "text", text: "본문\n" },
      { kind: "photo", text: PHOTO, url: URL },
    ]);
  });

  it("keeps every marker of a thread, in order", () => {
    const other = "https://pbs.twimg.com/media/OTHER.jpg";
    const segments = splitMediaMarkers(`첫 트윗\n\n${PHOTO}\n\n---\n\n둘째 트윗\n\n![](${other})`);
    expect(segments.filter((s) => s.kind === "photo")).toEqual([
      { kind: "photo", text: PHOTO, url: URL },
      { kind: "photo", text: `![](${other})`, url: other },
    ]);
  });

  it("rejoining the segments with a newline reproduces the input exactly", () => {
    const text = `첫 줄\n\n${PHOTO}\n\n마지막 줄\n\n[영상]`;
    expect(splitMediaMarkers(text).map((s) => s.text).join("\n")).toBe(text);
  });

  it("leaves a video marker as plain text — it carries no url to preview", () => {
    expect(splitMediaMarkers("[영상]")).toEqual([{ kind: "text", text: "[영상]" }]);
  });

  it("ignores an image that is not alone on its line", () => {
    const inline = `문장 안의 ${PHOTO} 이미지`;
    expect(splitMediaMarkers(inline)).toEqual([{ kind: "text", text: inline }]);
  });
});

describe("countMediaMarkers", () => {
  it("counts photos and videos separately", () => {
    expect(countMediaMarkers(`${PHOTO}\n\n[영상]\n\n[영상] https://video.mp4`)).toEqual({
      photos: 1,
      videos: 2,
    });
  });

  it("counts nothing for text with no marker", () => {
    expect(countMediaMarkers("[결과 확인]\n평범한 본문")).toEqual({ photos: 0, videos: 0 });
  });
});
