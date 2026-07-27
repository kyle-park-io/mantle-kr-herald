import { describe, it, expect } from "vitest";
import { assembleAlignmentWorksheet, type AlignmentBlock } from "../../../src/domain/translation/alignmentWorksheet";

const block = (over: Partial<AlignmentBlock> = {}): AlignmentBlock => ({
  itemId: "x:1",
  sourceText: "gm $MNT",
  draftKorean: "지엠 $MNT",
  precedents: [{ source: "gm $MNT fam", target: "안녕 $MNT 여러분" }],
  ...over,
});

describe("assembleAlignmentWorksheet", () => {
  it("renders 원문, 현재 번역, and 선례 pairs for a block", () => {
    const ws = assembleAlignmentWorksheet([block()]);
    expect(ws).toContain("### x:1");
    expect(ws).toContain("원문:\ngm $MNT");
    expect(ws).toContain("현재 번역:\n지엠 $MNT");
    expect(ws).toContain("- EN: gm $MNT fam\n  KO: 안녕 $MNT 여러분");
    expect(ws).toContain("번역:");
  });

  it("handles an empty block list — header only, no item sections", () => {
    const ws = assembleAlignmentWorksheet([]);
    expect(ws).toContain("정렬");
    expect(ws).not.toContain("###");
  });
});
