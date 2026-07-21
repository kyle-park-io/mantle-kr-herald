import { describe, it, expect } from "vitest";
import { emitPrMail, MAIL_MAX_LINE_OCTETS } from "../../../../src/domain/formatting/emitters/prMail";

describe("emitPrMail", () => {
  it("lifts the first line into 제목 and keeps the rest as the body", () => {
    const r = emitPrMail("맨틀, 메인넷 출시\n\n**본문** 내용입니다.");
    expect(r.segments[0].text).toBe("제목: 맨틀, 메인넷 출시\n\n본문 내용입니다.");
  });

  it("does not hard-wrap — mail clients re-wrap pasted text themselves", () => {
    const long = "가".repeat(200);
    expect(emitPrMail(`제목줄\n\n${long}`).segments[0].text).toContain(long);
  });

  it("warns when a line exceeds 998 octets, counting Hangul as 3 octets each", () => {
    // 333 Hangul = 999 octets, one past the RFC 5322 MUST
    const r = emitPrMail(`제목줄\n\n${"가".repeat(333)}`);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain(String(MAIL_MAX_LINE_OCTETS));
  });

  it("stays quiet when every line fits", () => {
    expect(emitPrMail("제목줄\n\n짧은 본문").warnings).toEqual([]);
  });
});
