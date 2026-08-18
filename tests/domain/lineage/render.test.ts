import { describe, it, expect } from "vitest";
import { renderLineage } from "../../../src/domain/lineage/render";
import type { LineageEntry } from "../../../src/domain/lineage/models";

const e = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "안녕", status: "translated", at: "T1", ...over,
});

describe("renderLineage", () => {
  it("shows 원문 on the first translated entry and its content", () => {
    const out = renderLineage([e({ sourceText: "hi", content: "안녕" })]);
    expect(out).toContain("translated");
    expect(out).toContain("원문:\nhi");
    expect(out).toContain("안녕");
  });

  it("diffs two same-stage entries: names removed and added lines", () => {
    const out = renderLineage([
      e({ content: "네이티브 AMM 뎁스", at: "T1" }),
      e({ content: "네이티브 AMM 유동성", at: "T2" }),
    ]);
    expect(out).toContain("- 네이티브 AMM 뎁스");
    expect(out).toContain("+ 네이티브 AMM 유동성");
  });

  it("notes a status change when content is unchanged (approve)", () => {
    const out = renderLineage([
      e({ stage: "rendered", variant: "announcement/telegram", content: "본문", status: "rendered", at: "T1" }),
      e({ stage: "rendered", variant: "announcement/telegram", content: "본문", status: "approved", at: "T2" }),
    ]);
    expect(out).toContain("상태: rendered → approved");
  });

  it("renders entries across stages in order", () => {
    const out = renderLineage([
      e({ stage: "translated", content: "번역", at: "T1" }),
      e({ stage: "converted", variant: "announcement", content: "공지", at: "T2" }),
    ]);
    expect(out.indexOf("translated")).toBeLessThan(out.indexOf("converted"));
  });

  it("names who wrote an entry, and says so when nobody recorded it", () => {
    const out = renderLineage([
      { itemId: "x:1", stage: "translated", content: "초안", status: "translated", actor: "agent", at: "2026-08-18T00:00:00.000Z" },
      { itemId: "x:1", stage: "translated", content: "검수본", status: "approved", actor: "human", at: "2026-08-18T01:00:00.000Z" },
      { itemId: "x:1", stage: "translated", content: "옛 행", status: "translated", at: "2026-08-18T02:00:00.000Z" },
    ]);
    expect(out).toContain("· 에이전트");
    expect(out).toContain("· 사람");
    expect(out).not.toContain("· undefined");
  });
});

/**
 * A fork's `variant` is `type/outletId`, so it gets its own diff key and its first entry prints in
 * full — which is what makes a discarded fork readable next to the group it diverged from. These
 * are the assertions behind the decision to leave the viewer alone.
 */
describe("renderLineage — forked rooms", () => {
  const group = e({ stage: "rendered", variant: "announcement/telegram", content: "그룹 글", status: "approved", at: "T1" });

  it("prints a fork's text in full rather than diffing it against the group rendering", () => {
    const out = renderLineage([group, e({ stage: "forked", variant: "announcement/tg-blockchain", content: "이 방 전용", status: "rendered", at: "T2" })]);
    expect(out).toContain("forked(announcement/tg-blockchain)");
    expect(out).toContain("내용:\n이 방 전용"); // not "변경:" against the group's text
  });

  it("says a revert happened even though the discarded text is identical to the previous entry", () => {
    const out = renderLineage([
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "이 방 전용", status: "rendered", at: "T2" }),
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "이 방 전용", status: "reverted", at: "T3" }),
    ]);
    // Without the distinct status this entry would read as "(내용 동일)" and nothing else — the one
    // moment a text was destroyed, rendered as a no-op.
    expect(out).toContain("상태: rendered → reverted");
  });

  it("prints the discarded text in full when the revert is the fork's only entry", () => {
    const out = renderLineage([group, e({ stage: "forked", variant: "announcement/tg-blockchain", content: "사라질 글", status: "reverted", at: "T2" })]);
    expect(out).toContain("버린 내용:\n사라질 글"); // recovery is a copy-paste out of this output
  });

  /**
   * The case that made this worth a viewer change: after a couple of revisions the discarded text
   * exists nowhere as a whole, only as a first version plus a chain of diffs.
   */
  it("prints the discarded text in full even when the fork has a revision history", () => {
    const out = renderLineage([
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "v1 첫 줄\n둘째 줄", status: "rendered", at: "T1" }),
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "v2 첫 줄\n둘째 줄", status: "rendered", at: "T2" }),
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "v2 첫 줄\n둘째 줄", status: "reverted", at: "T3" }),
    ]);
    expect(out).toContain("버린 내용:\nv2 첫 줄\n둘째 줄");
    expect(out).not.toContain("(내용 동일)"); // the destroyed text must never render as a no-op
  });

  it("still diffs a same-key revision that is not a removal", () => {
    const out = renderLineage([
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "v1", status: "rendered", at: "T1" }),
      e({ stage: "forked", variant: "announcement/tg-blockchain", content: "v2", status: "rendered", at: "T2" }),
    ]);
    expect(out).toContain("변경:");
    expect(out).not.toContain("버린 내용:");
  });
});
