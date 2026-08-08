import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countMediaMarkers, splitMediaMarkers } from "../../web/src/media";

const URL = "https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg";
const PHOTO = `![](${URL})`;
// A real marker as `XContentSource` now writes it — query string and all, which is part of the url
// twitterapi.io hands back and part of what has to survive the round trip.
const VIDEO_URL =
  "https://video.twimg.com/amplify_video/2076703853182074880/vid/avc1/720x720/vPz8ankm0777GHP_.mp4?tag=14";
const VIDEO = `[영상] ${VIDEO_URL}`;

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

  it("splits a video marker carrying a url out of the text around it", () => {
    expect(splitMediaMarkers(`본문\n\n${VIDEO}`)).toEqual([
      { kind: "text", text: "본문\n" },
      { kind: "video", text: VIDEO, url: VIDEO_URL },
    ]);
  });

  it("keeps the mp4's query string in the captured url", () => {
    // `?tag=14` is not decoration — it is part of the address that answers 200 with video/mp4.
    const [segment] = splitMediaMarkers(VIDEO);
    expect(segment.kind === "video" && segment.url).toBe(VIDEO_URL);
  });

  it("rejoining the segments with a newline reproduces the input exactly", () => {
    // Mixes prose with all three marker kinds — photo, video-with-url, legacy url-less video — so the
    // line-alignment invariant is pinned across every branch of the split, not just the photo one.
    const text = `첫 줄\n\n${PHOTO}\n\n가운데 줄\n\n${VIDEO}\n\n마지막 줄\n\n[영상]`;
    expect(splitMediaMarkers(text).map((s) => s.text).join("\n")).toBe(text);
  });

  it("leaves a url-less video marker as plain text — there is nothing to preview", () => {
    // Legacy text, and there will always be some: nothing re-derives stored text on read. Keeping it
    // a text segment is what makes it render exactly as it does today.
    expect(splitMediaMarkers("[영상]")).toEqual([{ kind: "text", text: "[영상]" }]);
  });

  it("ignores an image that is not alone on its line", () => {
    const inline = `문장 안의 ${PHOTO} 이미지`;
    expect(splitMediaMarkers(inline)).toEqual([{ kind: "text", text: inline }]);
  });

  it("ignores a video marker that is not alone on its line", () => {
    const inline = `문장 안의 ${VIDEO} 영상`;
    expect(splitMediaMarkers(inline)).toEqual([{ kind: "text", text: inline }]);
  });

  it("does not read prose after `[영상]` as a url — the send path would not either", () => {
    // The pattern stays as tight as `sourceMedia.ts`: one non-whitespace run and nothing after it.
    // Previewing something the send path does not treat as media is worse than not previewing.
    const line = "[영상] 어제 올린 영상";
    expect(splitMediaMarkers(line)).toEqual([{ kind: "text", text: line }]);
    expect(countMediaMarkers(line)).toEqual({ photos: 0, videos: 0, videosWithUrl: 0 });
  });
});

describe("countMediaMarkers", () => {
  it("counts both spellings of the video marker as videos", () => {
    expect(countMediaMarkers(`${PHOTO}\n\n[영상]\n\n${VIDEO}`)).toEqual({
      photos: 1,
      videos: 2,
      videosWithUrl: 1,
    });
  });

  it("reports how many videos can actually be previewed", () => {
    // What the edit-box notice needs: a copy carrying only legacy markers still has no preview,
    // and one carrying both kinds must not be described as if every video had one.
    expect(countMediaMarkers("[영상]\n\n[영상]")).toEqual({
      photos: 0,
      videos: 2,
      videosWithUrl: 0,
    });
    expect(countMediaMarkers(VIDEO)).toEqual({ photos: 0, videos: 1, videosWithUrl: 1 });
  });

  it("counts nothing for text with no marker", () => {
    expect(countMediaMarkers("[결과 확인]\n평범한 본문")).toEqual({
      photos: 0,
      videos: 0,
      videosWithUrl: 0,
    });
  });
});

/**
 * `web/src/media.ts` deliberately duplicates `PHOTO_LINE`/`VIDEO_LINE` from
 * `src/domain/media/sourceMedia.ts` — the frontend cannot import the backend file (`src/` is a Node
 * pipeline typechecked without the DOM lib; `web/` builds on its own tsconfig) — and the frontend
 * file's own comment names the backend file it must be kept in sync with. Nothing on the backend side
 * points back, and `src/` may not be touched to add that reference — so this guard has to live here,
 * on the side that CAN see both files, reading the backend source as text rather than importing it.
 *
 * A looser (or stricter) pattern on either side previews something the send path does not treat as
 * media (or misses something it does), which is worse than not previewing at all.
 */
describe("PHOTO_LINE / VIDEO_LINE stay identical to the backend", () => {
  const WEB_FILE = join(__dirname, "..", "..", "web", "src", "media.ts");
  const BACKEND_FILE = join(__dirname, "..", "..", "src", "domain", "media", "sourceMedia.ts");

  /** Pulls `const NAME = /.../;` regex literals out of a source file as their exact literal text. */
  const extractRegex = (filePath: string, name: string): string => {
    const source = readFileSync(filePath, "utf8");
    // A regex-literal body: no bare (unescaped) `/` or newline, same rule JS itself uses.
    const pattern = new RegExp(`const ${name} = (/(?:[^/\\\\\\n]|\\\\.)*/[a-z]*);`);
    const match = pattern.exec(source);
    if (!match) throw new Error(`could not find "const ${name} = /..../;" in ${filePath}`);
    return match[1];
  };

  for (const name of ["PHOTO_LINE", "VIDEO_LINE"] as const) {
    it(`${name} is byte-for-byte identical in web/src/media.ts and src/domain/media/sourceMedia.ts`, () => {
      const web = extractRegex(WEB_FILE, name);
      const backend = extractRegex(BACKEND_FILE, name);
      expect(
        web,
        `${name} drifted between web/src/media.ts and src/domain/media/sourceMedia.ts — change both, ` +
          `together, or the dashboard previews something the send path does not treat as media (or ` +
          `misses something it does).`,
      ).toBe(backend);
    });
  }
});
