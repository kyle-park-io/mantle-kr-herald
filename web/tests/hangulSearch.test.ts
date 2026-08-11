import { describe, expect, it } from "vitest";
import { compileQuery } from "../src/hangulSearch";

/** 질의가 본문에 걸리는가. 빈 질의는 `null`이 나오므로 "전부 통과"로 읽는다 — 호출부와 같은 규칙. */
const hit = (query: string, text: string): boolean => {
  const re = compileQuery(query);
  return re === null || re.test(text);
};

describe("compileQuery", () => {
  it("gives null for an empty or whitespace-only query", () => {
    expect(compileQuery("")).toBeNull();
    expect(compileQuery("   ")).toBeNull();
  });

  it("never carries the g flag, so .test() is not stateful", () => {
    const re = compileQuery("맨틀")!;
    expect(re.global).toBe(false);
    expect(re.test("맨틀 네트워크")).toBe(true);
    expect(re.test("맨틀 네트워크")).toBe(true);
  });

  it("matches by initial consonants", () => {
    expect(hit("ㅁㅌ", "맨틀 네트워크")).toBe(true);
    expect(hit("ㄴㅌㅇㅋ", "맨틀 네트워크")).toBe(true);
    expect(hit("ㅅㅌㅋ", "맨틀 네트워크")).toBe(false);
  });

  /**
   * 이 두 목록이 "타이핑 도중 결과가 깜빡이지 않는다"를 지킨다. React의 onChange는 IME 조합
   * 중에도 중간값으로 발화하므로, 지나가는 상태가 모두 걸려야 입력이 매끄럽다. 두 번째 목록은
   * 겹모음이 걸린 경우 — ㅎ + ㅗ 를 치면 화면에는 `호`가 서 있다가 ㅣ 가 오면 `회`가 된다.
   */
  it("matches every state typing 맨틀 passes through", () => {
    for (const q of ["ㅁ", "매", "맨", "맨ㅌ", "맨트", "맨틀"]) {
      expect(hit(q, "맨틀 네트워크"), q).toBe(true);
    }
  });

  it("matches every state typing 회의 passes through", () => {
    for (const q of ["ㅎ", "호", "회", "회ㅇ", "회으", "회의"]) {
      expect(hit(q, "회의록 정리"), q).toBe(true);
    }
  });

  it("keeps middle chunks strict, so only the last one is loose", () => {
    expect(hit("마늘", "마늘밭")).toBe(true);
    expect(hit("마늘", "만늘")).toBe(false);
    // 초성만 같고 중성이 다르면 안 걸린다 — 범위는 초성+중성에 걸려 있지 초성에만 걸려 있지 않다.
    expect(hit("마", "맨틀")).toBe(false);
    expect(hit("호박", "회의록")).toBe(false);
  });

  it("reads a trailing 종성 as the next syllable's 초성 too", () => {
    expect(hit("간", "가나다")).toBe(true);
    expect(hit("많", "만하다")).toBe(true);
  });

  it("lets a trailing 종성 grow into a 겹받침", () => {
    expect(hit("만", "많다")).toBe(true);
    expect(hit("업", "없다")).toBe(true);
  });

  it("lets a trailing 중성 grow into a 겹모음", () => {
    expect(hit("고", "과일")).toBe(true);
    expect(hit("구", "궈요")).toBe(true);
    expect(hit("거", "과일")).toBe(false);
  });

  it("matches a substring anywhere, not just the start", () => {
    expect(hit("네트", "맨틀 네트워크")).toBe(true);
    expect(hit("x:19", "x:1934567 맨틀")).toBe(true);
  });

  it("ignores case for latin text", () => {
    expect(hit("mantle", "The Mantle Network")).toBe(true);
    expect(hit("MANTLE", "the mantle network")).toBe(true);
  });

  it("treats regex metacharacters as literals", () => {
    expect(hit("a.c", "a.c")).toBe(true);
    expect(hit("a.c", "abc")).toBe(false);
    expect(hit("(주)", "(주)맨틀")).toBe(true);
    expect(hit("[1]", "[1] 공지")).toBe(true);
  });

  it("collapses whitespace so a typed space matches a wrapped one", () => {
    expect(hit("맨틀 네", "맨틀  네트워크")).toBe(true);
    // 반대 방향: 질의 쪽에 공백이 여러 개 있어도(줄 두 개를 복사하면 사이에 `\n\n`이 낀다) 본문의
    // 공백 하나에 걸려야 한다. 뭉치지 않으면 나란한 `\s+`가 "공백 N개 이상"을 요구하게 되어 실패한다.
    expect(hit("맨틀  네", "맨틀 네트워크")).toBe(true);
    expect(hit("맨틀\n\n네", "맨틀 네트워크")).toBe(true);
  });
});
