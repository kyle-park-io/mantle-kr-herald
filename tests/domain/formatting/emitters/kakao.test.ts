import { describe, it, expect } from "vitest";
import { emitKakaoPaste, KAKAO_FOLD } from "../../../../src/domain/formatting/emitters/kakao";

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
});
