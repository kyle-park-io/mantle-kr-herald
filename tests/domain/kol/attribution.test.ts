import { describe, it, expect } from "vitest";
import {
  normalizeForMatch, similarity, bestMatch, MATCH_THRESHOLD,
} from "../../../src/domain/kol/attribution";

describe("normalizeForMatch", () => {
  it("strips urls, emoji, and whitespace so only the words remain", () => {
    expect(normalizeForMatch("🙃 맨틀 출시 https://t.me/x 지금")).toBe("맨틀출시지금");
  });

  it("lowercases latin text so casing cannot change a score", () => {
    expect(normalizeForMatch("Mantle USPXx")).toBe("mantleuspxx");
  });

  it("is stable under reordered whitespace and newlines", () => {
    expect(normalizeForMatch("a b\n\nc")).toBe(normalizeForMatch("a  b c"));
  });
});

describe("similarity", () => {
  it("is 1 for identical text", () => {
    expect(similarity("맨틀에서 토큰화 주식이 거래됩니다", "맨틀에서 토큰화 주식이 거래됩니다")).toBe(1);
  });

  it("is 0 for text with nothing in common", () => {
    expect(similarity("맨틀 토큰화 주식", "오늘 점심 메뉴 추천")).toBe(0);
  });

  it("stays high when a KOL keeps our sentences but adds their own opener", () => {
    const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    const theirs = "🙃 이거 꼭 보세요 프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    expect(similarity(ours, theirs)).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("stays high when a KOL reorders our lines, which edit distance would punish", () => {
    const ours = "맨틀에서 토큰화 주식 거래 지원. 플럭션에서 리워드 캠페인 진행 중.";
    const theirs = "플럭션에서 리워드 캠페인 진행 중. 맨틀에서 토큰화 주식 거래 지원.";
    expect(similarity(ours, theirs)).toBeGreaterThan(0.8);
  });

  it("falls below the threshold for a different campaign about the same chain", () => {
    const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    const theirs = "맨틀 네트워크 데브방에서 이번 주 개발자 밋업이 열립니다 많이 오세요";
    expect(similarity(ours, theirs)).toBeLessThan(MATCH_THRESHOLD);
  });

  it("is 0 rather than NaN when either side normalizes to nothing", () => {
    expect(similarity("", "맨틀")).toBe(0);
    expect(similarity("🙃", "맨틀")).toBe(0);
  });

  it("is symmetric", () => {
    const a = "맨틀에서 토큰화 주식 거래 지원";
    const b = "맨틀에서 토큰화 주식 거래를 지원합니다";
    expect(similarity(a, b)).toBe(similarity(b, a));
  });
});

describe("bestMatch", () => {
  const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
  const other = "맨틀 데브방 개발자 밋업 공지입니다 많이 참여해주세요";

  it("picks the highest-scoring candidate", () => {
    const res = bestMatch(`🙃 ${ours}`, [
      { itemId: "x:222", text: other },
      { itemId: "x:111", text: ours },
    ]);
    expect(res!.itemId).toBe("x:111");
    expect(res!.score).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("returns undefined below the threshold rather than guessing", () => {
    expect(bestMatch("오늘 점심 뭐 먹지", [{ itemId: "x:111", text: ours }])).toBeUndefined();
  });

  it("returns undefined when there are no candidates, which is the July backfill case", () => {
    // No renderings exist before 2026-07-21, so a July sweep has nothing to match against.
    expect(bestMatch(ours, [])).toBeUndefined();
  });

  it("is deterministic when two candidates tie, preferring the earlier one", () => {
    const res = bestMatch(ours, [
      { itemId: "x:aaa", text: ours },
      { itemId: "x:bbb", text: ours },
    ]);
    expect(res!.itemId).toBe("x:aaa");
  });
});
