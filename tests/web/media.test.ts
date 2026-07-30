import { readFileSync } from "node:fs";
import { join } from "node:path";
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
