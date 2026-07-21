import { describe, it, expect } from "vitest";
import { toCanonical, splitPosts, stripBold, linksToPlain, linksToLabel } from "../../../src/domain/formatting/canonical";

describe("toCanonical", () => {
  it("keeps a single blank line as a paragraph break", () => {
    expect(toCanonical("첫 문단\n\n둘째 문단")).toBe("첫 문단\n\n둘째 문단");
  });

  it("keeps two blank lines as a post boundary", () => {
    expect(toCanonical("트윗 하나\n\n\n트윗 둘")).toBe("트윗 하나\n\n\n트윗 둘");
  });

  it("collapses more than two blank lines down to exactly one boundary", () => {
    expect(toCanonical("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("pins the collapse threshold: 3 newlines survive, 4 or more become exactly 3", () => {
    expect(toCanonical("a\n\n\nb")).toBe("a\n\n\nb");
    expect(toCanonical("a\n\n\n\nb")).toBe("a\n\n\nb");
    expect(toCanonical("a\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(toCanonical("a\n\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("normalises CRLF and trims the ends", () => {
    expect(toCanonical("  a\r\nb  ")).toBe("a\nb");
  });

  it("treats a --- separator line, blank lines and all, as a post boundary", () => {
    expect(toCanonical("가\n\n---\n\n나")).toBe("가\n\n\n나");
  });

  it("treats a --- separator with no surrounding blank lines as a post boundary", () => {
    expect(toCanonical("가\n---\n나")).toBe("가\n\n\n나");
  });

  it("treats four or more hyphens on their own line the same as three", () => {
    expect(toCanonical("가\n\n----\n\n나")).toBe("가\n\n\n나");
    expect(toCanonical("가\n\n-------\n\n나")).toBe("가\n\n\n나");
  });

  it("allows spaces or tabs around the hyphens on a separator line", () => {
    expect(toCanonical("가\n\n  ---  \n\n나")).toBe("가\n\n\n나");
    expect(toCanonical("가\n\n\t---\t\n\n나")).toBe("가\n\n\n나");
  });

  it("does not treat two hyphens alone on a line as a separator", () => {
    expect(toCanonical("가\n--\n나")).toBe("가\n--\n나");
  });

  it("does not touch hyphens inline in prose", () => {
    expect(toCanonical("가---나")).toBe("가---나");
    expect(toCanonical("단어 - 단어")).toBe("단어 - 단어");
  });

  it("does not touch a leading bullet dash", () => {
    expect(toCanonical("- bullet\n다음 줄")).toBe("- bullet\n다음 줄");
  });

  it("is idempotent: applying it twice matches applying it once", () => {
    const inputs = [
      "가\n\n---\n\n나",
      "가\n---\n나",
      "가\n\n\n나",
      "가---나",
      "단어 - 단어",
      "- bullet\n다음 줄",
      "가\n--\n나",
    ];
    for (const input of inputs) {
      const once = toCanonical(input);
      expect(toCanonical(once)).toBe(once);
    }
  });
});

describe("toCanonical + splitPosts integration", () => {
  it("splits a --- separated thread into separate posts", () => {
    expect(splitPosts(toCanonical("가\n\n---\n\n나"))).toEqual(["가", "나"]);
  });
});

describe("splitPosts", () => {
  it("splits on post boundaries and trims each post", () => {
    expect(splitPosts("하나\n\n\n둘\n\n\n셋")).toEqual(["하나", "둘", "셋"]);
  });

  it("keeps paragraph breaks inside a post", () => {
    expect(splitPosts("첫 줄\n\n같은 트윗\n\n\n다음 트윗")).toEqual(["첫 줄\n\n같은 트윗", "다음 트윗"]);
  });

  it("returns a single post when there is no boundary", () => {
    expect(splitPosts("혼자")).toEqual(["혼자"]);
  });

  it("returns one empty post for empty input rather than an empty list", () => {
    expect(splitPosts("")).toEqual([""]);
  });
});

describe("text helpers", () => {
  it("strips bold markers across newlines", () => {
    expect(stripBold("**첫 줄\n둘째 줄**")).toBe("첫 줄\n둘째 줄");
  });

  it("rewrites a markdown link as 'text (url)'", () => {
    expect(linksToPlain("공지 [자세히](https://x.io)")).toBe("공지 자세히 (https://x.io)");
  });

  it("keeps only the label when the destination renders links as entities", () => {
    expect(linksToLabel("공지 [자세히](https://x.io)")).toBe("공지 자세히");
  });
});
