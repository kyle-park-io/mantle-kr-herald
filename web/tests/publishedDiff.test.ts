import { describe, it, expect } from "vitest";
import { diffPublished } from "../src/publishedDiff";

/** The published text reassembled from its parts — nothing may be lost or reordered by diffing. */
const rebuilt = (draft: string, published: string) =>
  diffPublished(draft, published)
    .parts.map((p) => p.text)
    .join("");

/** Just the words the diff marked as the human's change. */
const changed = (draft: string, published: string) =>
  diffPublished(draft, published)
    .parts.filter((p) => p.changed)
    .map((p) => p.text.trim())
    .filter((t) => t !== "");

describe("diffPublished", () => {
  it("marks nothing when the published copy matches the draft", () => {
    const t = "가장 최근에 구매한 토큰화 자산은 무엇인가요?";
    expect(changed(t, t)).toEqual([]);
    expect(diffPublished(t, t).tooDifferent).toBe(false);
  });

  it("marks only the words the human actually changed", () => {
    // The motivating case, from production row x:2082149990282207365.
    const draft = "가장 최근에 구매하신 토큰화 자산은 무엇입니까?";
    const published = "가장 최근에 구매한 토큰화 자산은 무엇인가요?";
    expect(changed(draft, published)).toEqual(["구매한", "무엇인가요?"]);
  });

  it("marks an inserted sentence and leaves the untouched half alone", () => {
    const draft = "맨틀은 온체인 자본시장을 엽니다.";
    const published = "맨틀은 온체인 자본시장을 엽니다. 지금 확인해보세요.";
    expect(changed(draft, published)).toEqual(["지금", "확인해보세요."]);
  });

  it("marks nothing for words the human only deleted", () => {
    // A deletion leaves no token in the published text to highlight. The published block shows what
    // went out; what is gone from it cannot be pointed at, and inventing a marker for it would put
    // text on screen that the account never published.
    const draft = "맨틀은 온체인 자본시장을 엽니다. 지금 확인해보세요.";
    const published = "맨틀은 온체인 자본시장을 엽니다.";
    expect(changed(draft, published)).toEqual([]);
  });

  it("never loses or reorders the published text", () => {
    const draft = "첫 문장입니다. 둘째 문장입니다.";
    const published = "첫 문장이에요.\n\n완전히 다른 둘째 줄.";
    expect(rebuilt(draft, published)).toBe(published);
  });

  it("preserves newlines and runs of whitespace exactly", () => {
    const published = "한 줄.\n\n두 칸  띄운 줄.\n세 번째.";
    expect(rebuilt("무관한 초안.", published)).toBe(published);
  });

  it("gives up on highlighting when most of the copy is new", () => {
    // A full rewrite highlights end to end, which says nothing — the caller renders plain text and
    // a note instead. Today's lowest reconcile match scored 0.644, so rewrites this heavy are real.
    const draft = "맨틀은 온체인 자본시장을 엽니다.";
    const published = "완전히 다른 문장이 여기에 들어갑니다 전부 새로 쓴 내용입니다.";
    expect(diffPublished(draft, published).tooDifferent).toBe(true);
  });

  it("still highlights a heavily edited copy that shares most of its words", () => {
    const draft = "맨틀은 온체인 자본시장을 엽니다. 지금 확인해보세요.";
    const published = "맨틀은 온체인 자본시장을 엽니다. 지금 바로 확인해보세요.";
    expect(diffPublished(draft, published).tooDifferent).toBe(false);
    expect(changed(draft, published)).toEqual(["바로"]);
  });

  it("treats an empty draft as everything being new", () => {
    const d = diffPublished("", "게시된 글.");
    expect(d.tooDifferent).toBe(true);
    expect(rebuilt("", "게시된 글.")).toBe("게시된 글.");
  });

  it("returns no parts for an empty published text", () => {
    expect(diffPublished("초안.", "").parts).toEqual([]);
  });
});
