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

  /**
   * The exact contamination scenario `docs/ko/review.md` §3 reaches: a reviewer edits and saves
   * without approving (human "B"), `translate:align` rewrites it two hours later (agent "C"), then
   * the reviewer approves without touching the text again (a second human entry carrying "C"'s
   * content). Taking "the last human entry anywhere" would pair against "C" and mine the align
   * pass's own wording as if the reviewer had chosen it. The pair must stop at "B" — the first agent
   * entry ends the human's run, even though a later human entry follows it.
   */
  it("ends the human run at the next agent entry, even when a later human entry follows it", () => {
    expect(humanEditPairs([
      e({ content: "A", actor: "agent" }),
      e({ content: "B", actor: "human" }),
      e({ content: "C", actor: "agent" }),
      e({ content: "C", actor: "human" }),
    ])).toEqual([{ itemId: "x:1", before: "A", after: "B" }]);
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

  /**
   * The spec's §6 "No 2차 edits" boundary: a per-channel edit (`SaveRendering`'s `stage: "rendered"`)
   * has no English source to anchor a glossary term against, and `createDeps.ts` constructs that use
   * case with `actor: "human"` — so human-actor `rendered` rows genuinely exist in the table. This
   * module owns "which entries count" (see the module doc comment), so it — not a caller — has to be
   * the one that refuses a non-`translated` stage.
   */
  it("ignores a human entry from a different stage, e.g. a 2차 rendered edit", () => {
    expect(humanEditPairs([
      e({ stage: "translated", content: "정렬본", actor: "agent" }),
      e({ stage: "rendered", content: "채널별 문구", actor: "human" }),
    ])).toEqual([]);
  });
});
