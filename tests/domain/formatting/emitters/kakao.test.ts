import { describe, it, expect } from "vitest";
import { dotBullets, emitKakaoPaste, KAKAO_FOLD } from "../../../../src/domain/formatting/emitters/kakao";
import { toCanonical } from "../../../../src/domain/formatting/canonical";

describe("emitKakaoPaste", () => {
  it("emits plain text — KakaoTalk has no formatting at all", () => {
    const r = emitKakaoPaste("**공지** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe("공지 자세히 (https://x.io)");
  });

  it("warns past the 500-character fold without splitting", () => {
    const r = emitKakaoPaste("가".repeat(KAKAO_FOLD + 1));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain("전체보기");
  });

  it("tells the writer to shorten, not to split — KakaoTalk is never threaded", () => {
    const r = emitKakaoPaste("가".repeat(KAKAO_FOLD + 1));
    expect(r.warnings[0]).toContain("줄여야");
    expect(r.warnings[0]).not.toContain("나누");
  });

  it("stays quiet at exactly 500 characters", () => {
    expect(emitKakaoPaste("가".repeat(KAKAO_FOLD)).warnings).toEqual([]);
  });

  it("counts an astral character as one, not as its surrogate pair", () => {
    expect(emitKakaoPaste("🎉").segments[0].length).toBe(1);
  });

  it("flattens a post boundary to a single blank line — post boundaries are an x-only concept", () => {
    const r = emitKakaoPaste("a\n\n\nb");
    expect(r.segments[0].text).toBe("a\n\nb");
  });

  it("is always exactly one message, never several, given a post boundary", () => {
    const r = emitKakaoPaste("a\n\n\nb");
    expect(r.segments).toHaveLength(1);
  });

  it("is always exactly one message, never several, given a --- thread separator", () => {
    // The emitter itself never sees a literal "---": toCanonical runs upstream of every emitter
    // (see SaveRendering/FormatVariants) and folds "---" into the same \n\n\n post boundary before
    // storage. Route the input through toCanonical here too, so this test exercises what actually
    // reaches emitKakaoPaste rather than a spelling the pipeline never hands it.
    const canonical = toCanonical("a\n\n---\n\nb");
    const r = emitKakaoPaste(canonical);
    expect(r.segments).toHaveLength(1);
  });
});

/**
 * KakaoTalk parses no markup, so a `-` written as a list marker arrives as a literal hyphen sitting
 * in the reader's message — it reads as a dash, not as a list. `•` is what a bullet looks like when
 * nothing is going to render it for you. The guide's own skeleton (`conversion/kakao_notice.md` §4)
 * has the writer type `- 항목: 값`, so the swap belongs here rather than in the prompt.
 */
describe("dotBullets", () => {
  it("swaps a line-leading list marker for a bullet", () => {
    expect(dotBullets("[배경]\n- 프리 IPO 단계가 핵심 역할\n- 투자 기회 확대"))
      .toBe("[배경]\n• 프리 IPO 단계가 핵심 역할\n• 투자 기회 확대");
  });

  it("keeps the indentation a nested item was written with", () => {
    expect(dotBullets("  - 안쪽 항목")).toBe("  • 안쪽 항목");
  });

  it("leaves a hyphen in the middle of a line alone", () => {
    const line = "프리 IPO - 24시간 거래까지";
    expect(dotBullets(line)).toBe(line);
  });

  /** `---` is this pipeline's post separator, not a bullet. It has no space after the hyphen. */
  it("leaves a separator line alone", () => {
    expect(dotBullets("가\n---\n나")).toBe("가\n---\n나");
  });

  it("leaves a leading hyphen that is not a marker alone", () => {
    expect(dotBullets("-30% 하락")).toBe("-30% 하락");
  });
});

describe("emitKakaoPaste and bullets", () => {
  it("emits the bullet the reader sees", () => {
    expect(emitKakaoPaste("[배경]\n- 항목: 값").segments[0].text).toBe("[배경]\n• 항목: 값");
  });

  /** One character for one character, so nothing about this can push a notice over the fold. */
  it("costs nothing against the 500-character fold", () => {
    const body = "[배경]\n- 항목: 값\n- 항목: 값";
    expect(emitKakaoPaste(body).segments[0].length).toBe([...body].length);
  });
});
