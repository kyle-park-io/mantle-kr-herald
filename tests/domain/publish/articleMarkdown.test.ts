import { describe, it, expect } from "vitest";
import { toXArticleMarkdown } from "../../../src/domain/publish/articleMarkdown";

describe("toXArticleMarkdown", () => {
  it("replaces each ![](url) with a typ:media tag using the uploaded media_id", () => {
    const md = "# 제목\n\n본문\n\n![](https://pbs.twimg.com/media/a.jpg)\n\n더 본문";
    const out = toXArticleMarkdown(md, new Map([["https://pbs.twimg.com/media/a.jpg", "M1"]]));
    expect(out).toBe('# 제목\n\n본문\n\n<typ:media media_id="M1" />\n\n더 본문');
  });

  it("handles multiple images", () => {
    const md = "![](u1)\ntext\n![](u2)";
    const out = toXArticleMarkdown(md, new Map([["u1", "A"], ["u2", "B"]]));
    expect(out).toBe('<typ:media media_id="A" />\ntext\n<typ:media media_id="B" />');
  });

  it("leaves text without images unchanged", () => {
    expect(toXArticleMarkdown("# 제목\n\n본문뿐", new Map())).toBe("# 제목\n\n본문뿐");
  });

  it("leaves an image whose url is not in the map as-is (defensive)", () => {
    expect(toXArticleMarkdown("![](u1)", new Map())).toBe("![](u1)");
  });

  // The seam this pair of tests exists for: `renderArticle` writes an article's image blocks as
  // `[사진](url)` into the source (src/domain/articleMarkdown.ts), and until 2026-08-07 this
  // function only ever matched `![](url)`. An article's images therefore reached X only when the
  // translating agent happened to rewrite the marker on its way through — measured that day, it
  // rewrote 8 of 8 in one batch and preserved it in the batch before, so the images were riding on
  // a coin flip. Both spellings are the same marker (see `PHOTO_LINE` in domain/media/sourceMedia.ts,
  // which has always read both) and both must embed.
  it("replaces a [사진](url) marker with a typ:media tag", () => {
    const md = "# 제목\n\n본문\n\n[사진](https://pbs.twimg.com/media/a.jpg)\n\n더 본문";
    const out = toXArticleMarkdown(md, new Map([["https://pbs.twimg.com/media/a.jpg", "M1"]]));
    expect(out).toBe('# 제목\n\n본문\n\n<typ:media media_id="M1" />\n\n더 본문');
  });

  it("handles both spellings in one article", () => {
    const md = "[사진](u1)\ntext\n![](u2)";
    const out = toXArticleMarkdown(md, new Map([["u1", "A"], ["u2", "B"]]));
    expect(out).toBe('<typ:media media_id="A" />\ntext\n<typ:media media_id="B" />');
  });

  it("leaves an ordinary markdown link alone", () => {
    // `[사진](url)` is a markdown link by shape, so widening the pattern must not start eating
    // every link in an article body. Only the photo label is a marker.
    const md = "자세한 내용은 [문서](https://docs.mantle.xyz)에서 확인하세요";
    expect(toXArticleMarkdown(md, new Map([["https://docs.mantle.xyz", "M1"]]))).toBe(md);
  });
});
