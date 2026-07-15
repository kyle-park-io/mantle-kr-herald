import { describe, it, expect } from "vitest";
import { PrepareRefinements } from "../../src/app/PrepareRefinements";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { ContentVariant } from "../../src/domain/conversion/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "**메인넷** 출시",
    status: "approved", createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function conversionStore(list: ContentVariant[]): ConversionStore {
  return { loadAll: async () => list, upsert: async () => {}, listConvertedKeys: async () => new Set() };
}

describe("PrepareRefinements", () => {
  it("builds a worksheet + pending from approved variants' code-formatted drafts (default channels)", async () => {
    const { worksheet, pending } = await new PrepareRefinements(conversionStore([variant()])).run({});
    // x → default channels [x, kakao]
    expect(pending).toEqual([
      { itemId: "x:1", type: "x", channel: "x" },
      { itemId: "x:1", type: "x", channel: "kakao" },
    ]);
    expect(worksheet).toContain("## x:1 · X · x");
    expect(worksheet).toContain("메인넷 출시"); // ** stripped by the code formatter
    expect(worksheet).toContain("보정:");
  });

  it("ignores non-approved variants", async () => {
    const { pending } = await new PrepareRefinements(conversionStore([variant({ status: "converted" })])).run({});
    expect(pending).toEqual([]);
  });
});
