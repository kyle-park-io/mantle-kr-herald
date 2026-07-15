import { describe, it, expect } from "vitest";
import { FormatVariants } from "../../src/app/FormatVariants";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function stores(variants: ContentVariant[]) {
  const conversionStore: ConversionStore = { loadAll: async () => variants, upsert: async () => {}, listConvertedKeys: async () => new Set() };
  const saved: ChannelRendering[] = [];
  const formattingStore: FormattingStore = { loadAll: async () => saved, listRenderedKeys: async () => new Set(), upsert: async (r) => { saved.push(r); } };
  return { conversionStore, formattingStore, saved };
}

describe("FormatVariants", () => {
  it("formats approved variants to their default channels and persists refined:false renderings", async () => {
    const s = stores([variant()]); // x → default channels [x, kakao]
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, {}, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({});
    expect(renderings.map((r) => r.channel)).toEqual(["x", "kakao"]);
    expect(renderings.every((r) => r.refined === false)).toBe(true);
    expect(s.saved).toHaveLength(2);
  });

  it("ignores non-approved variants", async () => {
    const s = stores([variant({ status: "converted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings } = await uc.run({});
    expect(renderings).toHaveLength(0);
  });

  it("honors --channels override and collects warnings", async () => {
    const s = stores([variant({ convertedText: "가".repeat(281) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings, warnings } = await uc.run({ channels: ["x"] });
    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(warnings[0].messages.some((m) => m.includes("280"))).toBe(true);
  });
});
