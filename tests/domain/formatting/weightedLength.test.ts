import { describe, it, expect } from "vitest";
import { weightedLength, X_MAX_WEIGHTED, TCO_LENGTH } from "../../../src/domain/formatting/weightedLength";

describe("weightedLength", () => {
  it("counts ASCII as 1 per character", () => {
    expect(weightedLength("a".repeat(280))).toBe(280);
    expect(weightedLength("a".repeat(281))).toBe(281);
  });

  it("counts Hangul as 2 per character — 140 characters fills a post", () => {
    expect(weightedLength("가".repeat(140))).toBe(X_MAX_WEIGHTED);
    expect(weightedLength("가".repeat(141))).toBe(282);
  });

  it("counts any URL as exactly 23, whatever its real length", () => {
    expect(weightedLength("https://x.io")).toBe(TCO_LENGTH);
    expect(weightedLength(`https://example.com/${"a".repeat(200)}`)).toBe(TCO_LENGTH);
  });

  it("adds URL weight to surrounding text rather than replacing it", () => {
    // "공지 " = 2 Hangul (4) + 1 space (1) = 5, plus the URL's 23
    expect(weightedLength("공지 https://x.io")).toBe(5 + TCO_LENGTH);
  });

  it("counts emoji as 2 and newline as 1", () => {
    expect(weightedLength("🎉")).toBe(2);
    expect(weightedLength("\n")).toBe(1);
  });

  it("normalises to NFC before counting", () => {
    // Written as explicit \u escapes so no editor/tool can silently renormalise the
    // fixture: U+1100 U+1161 (decomposed jamo) composes to U+AC00 (precomposed "\uAC00").
    const decomposed = "\u1100\u1161";
    const precomposed = "\uAC00";
    expect(weightedLength(decomposed)).toBe(2);
    expect(weightedLength(decomposed)).toBe(weightedLength(precomposed));
  });

  it("counts the empty string as 0", () => {
    expect(weightedLength("")).toBe(0);
  });

  it("does not absorb trailing punctuation into the URL match", () => {
    // "(" + ")" = 2, plus the URL's 23
    expect(weightedLength("(https://x.io)")).toBe(2 + TCO_LENGTH);
    // "Check " = 6, "." = 1, plus the URL's 23
    expect(weightedLength("Check https://x.io.")).toBe(6 + 1 + TCO_LENGTH);
  });
});
