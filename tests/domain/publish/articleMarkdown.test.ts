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
});
