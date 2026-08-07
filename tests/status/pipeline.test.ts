import { describe, it, expect } from "vitest";
import { pipelineStages, formatStatus } from "../../src/status/pipeline";

describe("pipelineStages", () => {
  it("builds the five stages with totals and approved sub-counts", () => {
    const stages = pipelineStages({
      collected: 42,
      translations: [{ status: "translated" }, { status: "approved" }, { status: "approved" }],
      variants: [{ status: "converted" }, { status: "approved" }],
      renderings: [{ status: "rendered" }, { status: "rendered" }, { status: "approved" }],
      published: 5,
    });
    expect(stages.map((s) => [s.label, s.total, s.note])).toEqual([
      ["Collected (X + Lark)", 42, undefined],
      ["Translated", 3, "pending 1 · approved 2 · posted 0"],
      ["Converted (variants)", 2, "approved 1"],
      ["Rendered (channels)", 3, "approved 1"],
      ["Published (drive)", 5, undefined],
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
      published: 0,
    });
    const translated = stages.find((s) => s.label === "Translated");
    expect(translated?.total).toBe(23);
    expect(translated?.note).toBe("pending 2 · approved 0 · posted 21");
  });

  it("is all-zero on an empty pipeline", () => {
    const stages = pipelineStages({ collected: 0, translations: [], variants: [], renderings: [], published: 0 });
    expect(stages.every((s) => s.total === 0)).toBe(true);
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
        published: 1,
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
