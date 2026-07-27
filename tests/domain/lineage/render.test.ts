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
});
