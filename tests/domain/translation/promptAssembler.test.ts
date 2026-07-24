import { describe, it, expect } from "vitest";
import { assembleSharedContext, assembleItemBlock } from "../../../src/domain/translation/promptAssembler";
import type { SharedContext } from "../../../src/domain/translation/models";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const ctx: SharedContext = {
  role: "ROLE_TEXT",
  glossary: [
    { term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" },
    { term: "MNT", rule: "keep", note: "ticker", updatedAt: "2026-07-14" },
  ],
  styleGuide: { text: "STYLE_TEXT" },
  locale: { dateFormat: "YYYY년 M월 D일", numberFormat: "commas", currency: "USD", unit: "metric", honorific: "합니다체" },
  fewShots: [{ source: "Mantle mainnet", target: "맨틀 메인넷" }],
};

describe("assembleSharedContext", () => {
  it("includes role, each glossary term (with rule/target), style guide, locale, and few-shots — once", () => {
    const out = assembleSharedContext(ctx);
    expect(out).toContain("ROLE_TEXT");
    expect(out).toContain("Mantle");
    expect(out).toContain("transliterate");
    expect(out).toContain("맨틀");
    expect(out).toContain("MNT");
    expect(out).toContain("STYLE_TEXT");
    expect(out).toContain("합니다체");
    expect(out).toContain("Mantle mainnet");
    expect(out).toContain("맨틀 메인넷");
  });
});

describe("assembleItemBlock", () => {
  it("renders the item id, source text, and a translation marker", () => {
    const item: ContentItem = { id: "x:1", source: "x", text: "Hello Mantle", createdAt: "2026-01-01T00:00:00.000Z" };
    const out = assembleItemBlock(item);
    expect(out).toContain("x:1");
    expect(out).toContain("Hello Mantle");
    expect(out).toContain("번역:");
    expect(out).not.toContain("ROLE_TEXT"); // shared context is NOT repeated per item
  });

  it("includes grounding when provided", () => {
    const item: ContentItem = { id: "lark:9", source: "lark", text: "T", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(assembleItemBlock(item, "GROUND")).toContain("GROUND");
  });

  it("marks an article item in the heading so a reviewer can tell it apart before opening it", () => {
    const article: ContentItem = { id: "x:1", source: "x", text: "T", createdAt: "2026-01-01T00:00:00.000Z", kind: "article" };
    const out = assembleItemBlock(article);
    expect(out.split("\n")[0]).toBe("### x:1 [article]");
  });

  it("does not mark a post item (kind undefined or 'post')", () => {
    const noKind: ContentItem = { id: "x:2", source: "x", text: "T", createdAt: "2026-01-01T00:00:00.000Z" };
    const post: ContentItem = { ...noKind, id: "x:3", kind: "post" };
    expect(assembleItemBlock(noKind).split("\n")[0]).toBe("### x:2");
    expect(assembleItemBlock(post).split("\n")[0]).toBe("### x:3");
  });
});
