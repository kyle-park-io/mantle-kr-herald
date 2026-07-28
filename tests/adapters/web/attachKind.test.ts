import { describe, it, expect } from "vitest";
import { attachKind } from "../../../src/adapters/web/attachKind";
import type { Translation } from "../../../src/domain/translation/models";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const tr = (itemId: string): Translation =>
  ({ itemId, source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" });
const item = (id: string, kind?: "post" | "article"): ContentItem =>
  ({ id, source: "x", text: "x", createdAt: "c", kind });

describe("attachKind", () => {
  it("attaches each source item's kind by itemId", () => {
    const [r] = attachKind([tr("x:1")], [item("x:1", "article")]);
    expect(r.kind).toBe("article");
  });
  it("leaves kind undefined when the source item is absent", () => {
    const [r] = attachKind([tr("x:9")], [item("x:1", "post")]);
    expect(r.kind).toBeUndefined();
  });
  it("does not mutate the input translation", () => {
    const input = tr("x:1");
    attachKind([input], [item("x:1", "post")]);
    expect("kind" in input).toBe(false);
  });
});
