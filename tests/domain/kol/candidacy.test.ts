import { describe, it, expect } from "vitest";
import { isMantleCandidate } from "../../../src/domain/kol/candidacy";

describe("isMantleCandidate", () => {
  it("matches the Korean name, which is what KOL posts actually use", () => {
    expect(isMantleCandidate("🙃 맨틀, 프랭클린 미국 주식 ETF $USPXx 출시")).toBe(true);
  });

  it("matches the English name regardless of case", () => {
    expect(isMantleCandidate("USPXx Live on Mantle")).toBe(true);
    expect(isMantleCandidate("live on MANTLE now")).toBe(true);
  });

  it("matches the ticker with or without a dollar sign", () => {
    expect(isMantleCandidate("$MNT 매수")).toBe(true);
    expect(isMantleCandidate("MNT 스테이킹 안내")).toBe(true);
  });

  it("does not fire on MNT inside a longer token", () => {
    expect(isMantleCandidate("MNTUSDT 차트 봅니다")).toBe(false);
    expect(isMantleCandidate("MNTL 에어드랍")).toBe(false);
  });

  it("does not fire on an unrelated post", () => {
    expect(isMantleCandidate("비트코인 그냥 홀딩합니다")).toBe(false);
  });

  it("is false for empty text, so a photo-only post is not a candidate", () => {
    expect(isMantleCandidate("")).toBe(false);
  });
});
