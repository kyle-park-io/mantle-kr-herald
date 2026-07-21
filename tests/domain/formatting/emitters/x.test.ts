import { describe, it, expect } from "vitest";
import { emitXPaste, emitXTypefully } from "../../../../src/domain/formatting/emitters/x";

describe("emitXPaste", () => {
  it("strips bold to plain text — never unicode bold", () => {
    const r = emitXPaste("**메인넷** 출시");
    expect(r.segments[0].text).toBe("메인넷 출시");
    // U+1D5D4 is MATHEMATICAL SANS-SERIF BOLD CAPITAL A; nothing in that block may appear
    expect([...r.segments[0].text].every((c) => c.codePointAt(0)! < 0x1d400)).toBe(true);
  });

  it("leaves hashtags, mentions and t.co links untouched", () => {
    const r = emitXPaste("#Mantle @Mantle_Official https://t.co/x");
    expect(r.segments[0].text).toBe("#Mantle @Mantle_Official https://t.co/x");
  });

  it("rewrites markdown links as 'text (url)'", () => {
    expect(emitXPaste("공지 [자세히](https://x.io)").segments[0].text).toBe("공지 자세히 (https://x.io)");
  });

  it("turns post boundaries into segments and labels them", () => {
    const r = emitXPaste("하나\n\n\n둘\n\n\n셋");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘", "셋"]);
    expect(r.segments.map((s) => s.label)).toEqual(["트윗 1/3", "트윗 2/3", "트윗 3/3"]);
  });

  it("leaves a single post unlabelled", () => {
    expect(emitXPaste("혼자").segments[0].label).toBeUndefined();
  });

  it("measures each segment by weight, so 140 Hangul is at the limit and 141 is over", () => {
    const ok = emitXPaste("가".repeat(140));
    expect(ok.segments[0].length).toBe(280);
    expect(ok.segments[0].overLimit).toBe(false);
    expect(ok.warnings).toEqual([]);

    const over = emitXPaste("가".repeat(141));
    expect(over.segments[0].overLimit).toBe(true);
    expect(over.warnings).toEqual(["282/280 (2 초과)"]);
  });

  it("names the offending tweet when only one segment of a thread is over", () => {
    const r = emitXPaste(`짧음\n\n\n${"가".repeat(200)}`);
    expect(r.warnings).toEqual(["트윗 2/2: 400/280 (120 초과)"]);
  });

  it("never splits on its own — an over-limit post stays one segment", () => {
    expect(emitXPaste("가".repeat(500)).segments).toHaveLength(1);
  });

  it("warns when bold spans a post boundary, leaking an unbalanced ** into each half", () => {
    const r = emitXPaste("**가\n\n\n나**");
    expect(r.segments.map((s) => s.text)).toEqual(["**가", "나**"]);
    expect(r.warnings).toEqual([
      "트윗 1/2: 볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다",
      "트윗 2/2: 볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다",
    ]);
  });
});

describe("emitXTypefully", () => {
  // Asserts real output, not `toEqual(emitXPaste(...))` — the two are the same function today,
  // so comparing them would assert nothing and would keep passing if both broke together.
  it("emits plain-text segments split on post boundaries, measured against the 280 limit", () => {
    const r = emitXTypefully("**하나**\n\n\n[둘](https://x.io)");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘 (https://x.io)"]);
    expect(r.segments.map((s) => s.limit)).toEqual([280, 280]);
    expect(r.warnings).toEqual([]);
  });
});
