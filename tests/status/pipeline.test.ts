import { describe, it, expect } from "vitest";
import { pipelineStages, formatStatus, funnelCounts } from "../../src/status/pipeline";

describe("pipelineStages", () => {
  it("builds the five stages with totals and approved sub-counts", () => {
    const stages = pipelineStages({
      collected: 42,
      translations: [{ status: "translated" }, { status: "approved" }, { status: "approved" }],
      variants: [
        { itemId: "x:1", status: "converted" },
        { itemId: "x:2", status: "approved" },
      ],
      renderings: [
        { itemId: "x:1", status: "rendered" },
        { itemId: "x:1", status: "rendered" },
        { itemId: "x:2", status: "approved" },
      ],
      published: Array.from({ length: 5 }, (_, i) => ({ itemId: `x:${i}` })),
    });
    expect(stages.map((s) => [s.label, s.total, s.note])).toEqual([
      ["Collected (X + Lark)", 42, undefined],
      ["Translated", 3, "pending 1 · approved 2 · posted 0"],
      ["Converted (variants)", 2, "2 items · approved 1"],
      ["Rendered (channels)", 3, "2 items · approved 1"],
      ["Published (drive)", 5, "5 items"],
    ]);
  });

  it("splits the translated note three ways, so a terminal `posted` is not read as a review queue", () => {
    const stages = pipelineStages({
      collected: 0,
      translations: [
        { status: "translated" },
        { status: "translated" },
        ...Array.from({ length: 21 }, () => ({ status: "posted" })),
      ],
      variants: [],
      renderings: [],
      published: [],
    });
    const translated = stages.find((s) => s.label === "Translated");
    expect(translated?.total).toBe(23);
    expect(translated?.note).toBe("pending 2 · approved 0 · posted 21");
  });

  it("names the item count of every stage that fans out, because rows there are not comparable", () => {
    // Three items, each converted to several types and rendered to several channels. Read as bare
    // totals these stages appear to *gain* work between them (10 → 13); what actually happened is
    // three items fanning out twice.
    const stages = pipelineStages({
      collected: 0,
      translations: [],
      variants: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "converted" },
        { itemId: "x:2", status: "approved" },
      ],
      renderings: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "rendered" },
        { itemId: "x:2", status: "rendered" },
      ],
      published: [{ itemId: "x:1" }, { itemId: "x:1" }, { itemId: "x:9" }],
    });
    const note = (label: string) => stages.find((s) => s.label === label)?.note;
    expect(note("Converted (variants)")).toBe("2 items · approved 2");
    expect(note("Rendered (channels)")).toBe("2 items · approved 2");
    expect(note("Published (drive)")).toBe("2 items");
  });

  it("is all-zero on an empty pipeline", () => {
    const stages = pipelineStages({ collected: 0, translations: [], variants: [], renderings: [], published: [] });
    expect(stages.every((s) => s.total === 0)).toBe(true);
  });
});

describe("funnelCounts", () => {
  it("gives every stage both counts, so the dashboard cannot drift from `pnpm status`", () => {
    // The same input the CLI renders. Both readers derive from this one function precisely because
    // the previous split let the CLI learn about `posted` while the dashboard header did not.
    const counts = funnelCounts({
      collected: 134,
      translations: [{ status: "translated" }, { status: "posted" }],
      variants: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "converted" },
        { itemId: "x:2", status: "approved" },
      ],
      renderings: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "rendered" },
      ],
      published: [{ itemId: "x:1" }, { itemId: "x:1" }, { itemId: "x:9" }],
    });
    expect(counts).toEqual({
      // One row per item at these two stages — the stores key on itemId alone.
      collected: { items: 134, rows: 134 },
      translated: { items: 2, rows: 2 },
      // Past here a row is a (type) or (type, channel) or (status, target) fan-out of an item.
      converted: { items: 2, rows: 3 },
      rendered: { items: 1, rows: 2 },
      published: { items: 2, rows: 3 },
    });
  });
});

describe("formatStatus", () => {
  it("renders a header, each stage label + count, and the approved notes", () => {
    const out = formatStatus(
      pipelineStages({
        collected: 7,
        translations: [{ status: "approved" }],
        variants: [],
        renderings: [],
        published: [{ itemId: "x:1" }],
      }),
    );
    expect(out).toContain("Pipeline status");
    expect(out).toContain("Collected (X + Lark)");
    expect(out).toContain("7");
    expect(out).toContain("Translated");
    expect(out).toContain("(pending 0 · approved 1 · posted 0)");
    expect(out).toContain("Published (drive)");
  });
});
