import { describe, it, expect } from "vitest";
import { replyAndLinkSuffix, assembleItemBlock } from "../../../src/domain/translation/promptAssembler";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

describe("replyAndLinkSuffix", () => {
  it("is empty when neither field is present", () => {
    expect(replyAndLinkSuffix()).toBe("");
    expect(replyAndLinkSuffix(false, undefined)).toBe("");
  });
  it("adds the reply marker only", () => {
    expect(replyAndLinkSuffix(true, undefined)).toBe(" (댓글·옵셔널)");
  });
  it("adds the link only", () => {
    expect(replyAndLinkSuffix(false, "https://x.com/a/status/1")).toBe(" · [원문](https://x.com/a/status/1)");
  });
  it("adds both, marker before link", () => {
    expect(replyAndLinkSuffix(true, "https://x.com/a/status/1")).toBe(" (댓글·옵셔널) · [원문](https://x.com/a/status/1)");
  });
});

describe("assembleItemBlock header", () => {
  const base: ContentItem = { id: "x:1", source: "x", text: "hi", createdAt: "2026-07-28T00:00:00Z" };
  it("article reply with a link: kind marker, then reply, then link", () => {
    const block = assembleItemBlock({ ...base, kind: "article", isReply: true, refUrl: "https://x.com/a/status/1" });
    expect(block.split("\n")[0]).toBe("### x:1 [article] (댓글·옵셔널) · [원문](https://x.com/a/status/1)");
  });
  it("plain post with a link only", () => {
    const block = assembleItemBlock({ ...base, id: "x:2", kind: "post", refUrl: "https://x.com/a/status/2" });
    expect(block.split("\n")[0]).toBe("### x:2 · [원문](https://x.com/a/status/2)");
  });
  it("a Lark item (no fields) is unchanged", () => {
    const block = assembleItemBlock({ id: "lark:3", source: "lark", text: "hi", createdAt: "2026-07-28T00:00:00Z" });
    expect(block.split("\n")[0]).toBe("### lark:3");
  });
});
