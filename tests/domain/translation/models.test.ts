import { describe, it, expect } from "vitest";
import { DEFAULT_ROLE } from "../../../src/domain/translation/role";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { Translation } from "../../../src/domain/translation/models";

describe("translation domain", () => {
  it("DEFAULT_ROLE is a non-empty translator persona", () => {
    expect(typeof DEFAULT_ROLE).toBe("string");
    expect(DEFAULT_ROLE.length).toBeGreaterThan(0);
  });

  it("ContentItem and Translation types are usable", () => {
    const item: ContentItem = { id: "x:1", source: "x", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" };
    const t: Translation = {
      itemId: item.id, source: "x", sourceText: "hi", koreanText: "안녕",
      status: "translated", translatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(t.itemId).toBe("x:1");
  });
});
