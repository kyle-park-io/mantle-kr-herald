import { describe, it, expect } from "vitest";
import { humanEditPairs } from "../../../src/domain/lineage/humanEdits";
import type { LineageEntry } from "../../../src/domain/lineage/models";

const e = (over: Partial<LineageEntry>): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "", at: "2026-08-18T00:00:00.000Z", ...over,
});

describe("humanEditPairs", () => {
  it("pairs the last agent draft against what the human left", () => {
    expect(humanEditPairs([
      e({ content: "초안", actor: "agent" }),
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "검수본" }]);
  });

  /** The question is what the reviewer changed, not what the pipeline changed. */
  it("uses the aligned text as the baseline, not the original draft", () => {
    const [pair] = humanEditPairs([
      e({ content: "초안", actor: "agent" }),
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
    ]);
    expect(pair.before).not.toBe("초안");
  });

  it("takes the human's last word when a reviewer saved twice", () => {
    expect(humanEditPairs([
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "중간", actor: "human" }),
      e({ content: "최종", actor: "human" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "최종" }]);
  });

  /** A re-run after an edit must not become the baseline — it comes after the human, not before. */
  it("ignores an agent entry that lands after the human's", () => {
    expect(humanEditPairs([
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
      e({ content: "재실행", actor: "agent" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "검수본" }]);
  });

  it("yields nothing when no human ever touched it", () => {
    expect(humanEditPairs([e({ content: "초안", actor: "agent" })])).toEqual([]);
  });

  it("yields nothing when the human changed nothing", () => {
    expect(humanEditPairs([
      e({ content: "같은 글", actor: "agent" }),
      e({ content: "같은 글", actor: "human" }),
    ])).toEqual([]);
  });

  /** Null actors predate the column; guessing one would manufacture the confidence this exists for. */
  it("skips an item whose entries have no actor at all", () => {
    expect(humanEditPairs([e({ content: "초안" }), e({ content: "고친 글" })])).toEqual([]);
  });

  it("yields nothing when a human entry has no agent entry before it", () => {
    expect(humanEditPairs([e({ content: "사람이 처음 쓴 글", actor: "human" })])).toEqual([]);
  });
});
