import { describe, it, expect } from "vitest";
import { renderReview, renderApproved, safeFileName } from "../../../src/domain/publish/renderers";
import type { Translation } from "../../../src/domain/translation/models";

function tr(over: Partial<Translation> = {}): Translation {
  return {
    itemId: "x:100", source: "x", sourceText: "Hello Mantle", koreanText: "안녕 맨틀",
    status: "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("safeFileName", () => {
  it("replaces non-filename chars and appends .md", () => {
    expect(safeFileName("x:100")).toBe("x-100.md");
    expect(safeFileName("lark:om_1")).toBe("lark-om_1.md");
  });
});

describe("renderReview", () => {
  it("includes the id, source text, and Korean text", () => {
    const out = renderReview(tr());
    expect(out).toContain("x:100");
    expect(out).toContain("Hello Mantle");
    expect(out).toContain("안녕 맨틀");
    expect(out).toContain("원문");
    expect(out).toContain("한글");
  });
});

describe("renderApproved", () => {
  it("contains only the Korean text (no source)", () => {
    const out = renderApproved(tr({ status: "approved", koreanText: "승인된 한글" }));
    expect(out).toContain("승인된 한글");
    expect(out).not.toContain("Hello Mantle");
  });
});
