import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 손가락에 맞는 최소 크기(44px)를 `pointer-coarse`에서만 준다. 뷰포트가 아니라 입력 장치를 보므로
 * 창을 좁힌 데스크톱에서 버튼이 뚱뚱해지지 않고, 터치 노트북에서는 커진다.
 *
 * 문자열로 고정하는 이유: 이 클래스가 빠지면 화면은 멀쩡해 보이고 손가락만 빗나간다 — 눈으로
 * 리뷰해서 잡히지 않는 종류의 회귀다.
 */
it("보드 버튼의 공통 BASE가 pointer-coarse 최소 높이를 들고 있다", () => {
  const source = readFileSync(join(__dirname, "../src/buttonStyles.ts"), "utf8");
  const base = source.match(/const BASE = "([^"]+)"/)?.[1];
  expect(base).toBeDefined();
  expect(base).toContain("pointer-coarse:min-h-11");
});
