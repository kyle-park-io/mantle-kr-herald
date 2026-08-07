import { describe, it, expect } from "vitest";
import { diffPublished } from "../src/publishedDiff";

/** The published text reassembled from its parts — nothing may be lost or reordered by diffing. */
const rebuilt = (draft: string, published: string) =>
  diffPublished(draft, published)
    .parts.map((p) => p.text)
    .join("");

/** Just the runs the diff marked as the human's change. */
const changed = (draft: string, published: string) =>
  diffPublished(draft, published)
    .parts.filter((p) => p.changed)
    .map((p) => p.text);

/** Share of the published text that came out marked. */
const changedShare = (draft: string, published: string) =>
  changed(draft, published).join("").length / published.length;

describe("diffPublished", () => {
  it("marks nothing when the published copy matches the draft", () => {
    const t = "가장 최근에 구매한 토큰화 자산은 무엇인가요?";
    expect(changed(t, t)).toEqual([]);
    expect(diffPublished(t, t).tooDifferent).toBe(false);
  });

  it("marks only the changed part of a Korean word, not the whole word", () => {
    // The reason this diff is character-level. Korean is agglutinative, so a small edit changes the
    // whole whitespace token: `구매하신` and `구매한` share no token, and a word-level diff called
    // 58% of this production pair "new" and switched the highlight off entirely. Per character the
    // same pair is 16%.
    const draft = "가장 최근에 구매하신 토큰화 자산은 무엇입니까?";
    const published = "가장 최근에 구매한 토큰화 자산은 무엇인가요?";
    const marks = changed(draft, published).join("");
    expect(marks).not.toContain("구매"); // the shared stem is not marked
    expect(marks).not.toContain("토큰화"); // an untouched word is not marked
    expect(changedShare(draft, published)).toBeLessThan(0.3);
    expect(diffPublished(draft, published).tooDifferent).toBe(false);
  });

  it("marks an appended sentence and leaves the untouched half alone", () => {
    const draft = "맨틀은 온체인 자본시장을 엽니다.";
    const published = "맨틀은 온체인 자본시장을 엽니다. 지금 확인해보세요.";
    expect(changed(draft, published).join("")).toBe(" 지금 확인해보세요.");
  });

  it("marks nothing for text the human only deleted", () => {
    // A deletion leaves nothing in the published text to point at, and inventing a marker would put
    // text on screen the account never published.
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

  it("keeps a thread separator intact when both sides carry one", () => {
    const t = "첫 트윗\n\n---\n\n둘째 트윗";
    expect(rebuilt(t, t)).toBe(t);
    expect(changed(t, t)).toEqual([]);
  });

  it("does not shatter a rewritten passage into confetti", () => {
    // Seen in the browser, not in a test: rewriting `5,300만 달러에서 92.2억 달러로` as
    // `$53M에서 $9.22B로.` shares digits by coincidence, so a raw LCS marked `$`, `53`, `M`, `에서`
    // as separate spans with one- and two-character gaps between them. Correct, and unreadable —
    // it renders as a row of little boxes. Short unchanged gaps inside an edited passage are
    // absorbed so the reviewer sees the passage, not the algorithm.
    const draft = "온체인 거래량이 5,300만 달러에서 92.2억 달러로 늘었습니다.";
    const published = "온체인 거래량이 $53M에서 $9.22B로 늘었습니다.";
    const d = diffPublished(draft, published);
    expect(d.parts.filter((p) => p.changed).length).toBeLessThanOrEqual(2);
    expect(d.parts.map((p) => p.text).join("")).toBe(published);
    // The untouched head and tail must stay out of the highlight.
    expect(changed(draft, published).join("")).not.toContain("온체인");
    expect(changed(draft, published).join("")).not.toContain("늘었습니다");
  });

  it("does not merge two genuinely separate edits into one span", () => {
    // The bridging above must not swallow a long untouched middle.
    const draft = "첫 부분은 이렇습니다. 가운데는 손대지 않은 아주 긴 문장이 그대로 있습니다. 끝은 이렇습니다.";
    const published = "첫 부분은 저렇습니다. 가운데는 손대지 않은 아주 긴 문장이 그대로 있습니다. 끝은 저렇습니다.";
    const d = diffPublished(draft, published);
    expect(d.parts.filter((p) => p.changed).length).toBe(2);
  });

  it("gives up on highlighting when most of the copy is new", () => {
    const draft = "맨틀은 온체인 자본시장을 엽니다.";
    const published = "전혀 다른 주제로 쓴 완전히 새로운 홍보 문구가 여기 들어갑니다.";
    expect(diffPublished(draft, published).tooDifferent).toBe(true);
  });

  it("gives up rather than hanging on two very long, very different texts", () => {
    // The LCS table is |draft| x |published|; without a cap a pair of long articles would allocate a
    // table big enough to matter in a browser tab. Rendering plain is the right answer there anyway.
    const draft = "가".repeat(9000);
    const published = "나".repeat(9000);
    const started = Date.now();
    const d = diffPublished(draft, published);
    expect(d.tooDifferent).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(d.parts.map((p) => p.text).join("")).toBe(published);
  });

  it("still diffs a long pair that shares almost everything", () => {
    // Common prefix and suffix are stripped before the table is sized, so the expensive case is only
    // a long pair that genuinely differs in the middle. Measured on the real 2,458-character article
    // pair: 7 changed characters, 37ms.
    const body = "맨틀의 온체인 자본시장 이야기. ".repeat(200);
    const draft = `${body}끝맺음입니다.`;
    const published = `${body}끝맺음이에요.`;
    const d = diffPublished(draft, published);
    expect(d.tooDifferent).toBe(false);
    expect(changed(draft, published).join("").length).toBeLessThan(10);
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
