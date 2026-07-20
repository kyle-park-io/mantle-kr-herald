import { describe, it, expect } from "vitest";
import { formatForChannel, DEFAULT_CHANNELS_BY_TYPE, ALL_CHANNELS } from "../../../src/domain/formatting/channelFormat";

describe("DEFAULT_CHANNELS_BY_TYPE", () => {
  it("maps each type to its default channels", () => {
    expect(DEFAULT_CHANNELS_BY_TYPE.x).toEqual(["x"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toEqual(["telegram", "kakao"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toEqual(["telegram"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.pr).toEqual(["pr_mail"]);
    // telegram carries two types on purpose: an announcement and a KOL request are different copy
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toContain("telegram");
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toContain("telegram");
    expect(ALL_CHANNELS).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});

describe("formatForChannel — x", () => {
  it("strips bold to plain by default and preserves hashtags/mentions/links", () => {
    const r = formatForChannel("**메인넷** 출시! #Mantle @Mantle_Official https://t.co/x", "x");
    expect(r.text).toBe("메인넷 출시! #Mantle @Mantle_Official https://t.co/x");
    expect(r.warnings).toEqual([]);
  });
  it("maps bold to unicode (sans-serif bold) when opts.xBold=unicode", () => {
    const r = formatForChannel("**AB**", "x", { xBold: "unicode" });
    // U+1D5D4 = MATHEMATICAL SANS-SERIF BOLD CAPITAL A, U+1D5D5 = ...B
    expect([...r.text].map((c) => c.codePointAt(0))).toEqual([0x1d5d4, 0x1d5d5]);
  });
  it("warns when the result exceeds 280 characters", () => {
    const r = formatForChannel("가".repeat(281), "x");
    expect(r.warnings.some((w) => w.includes("280"))).toBe(true);
  });
  it("collapses 3+ blank lines to a single blank line", () => {
    const r = formatForChannel("a\n\n\n\nb", "x");
    expect(r.text).toBe("a\n\nb");
  });
  it("rewrites markdown links to plain text (consistent with kakao/pr_mail)", () => {
    const r = formatForChannel("공지 [자세히](https://x.io)", "x");
    expect(r.text).toBe("공지 자세히 (https://x.io)");
  });
});

describe("formatForChannel — telegram", () => {
  it("converts **bold** to *bold* and keeps links", () => {
    const r = formatForChannel("**중요** 링크 https://x.io", "telegram");
    expect(r.text).toBe("*중요* 링크 https://x.io");
    expect(r.warnings).toEqual([]);
  });
  it("handles a **bold** span that wraps across a newline (no leaked **)", () => {
    const r = formatForChannel("**첫째 줄\n둘째 줄**", "telegram");
    expect(r.text).toBe("*첫째 줄\n둘째 줄*");
  });
});

describe("formatForChannel — kakao", () => {
  it("removes bold and rewrites markdown links to 'text (url)'", () => {
    const r = formatForChannel("**공지** [자세히](https://x.io)", "kakao");
    expect(r.text).toBe("공지 자세히 (https://x.io)");
  });
});

describe("formatForChannel — pr_mail", () => {
  it("uses the first line as 제목 and the rest as body, stripped of bold", () => {
    const r = formatForChannel("맨틀, 메인넷 출시\n\n**본문** 내용입니다.", "pr_mail");
    expect(r.text).toBe("제목: 맨틀, 메인넷 출시\n\n본문 내용입니다.");
  });
});
