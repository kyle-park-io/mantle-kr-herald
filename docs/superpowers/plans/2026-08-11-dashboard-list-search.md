# 사이드바 검색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 1차·2차 사이드바의 상태 필터 아래에 검색창을 하나씩 두어, 검수자가 본문 구절이나 `x:` id로 — 초성(`ㅁㅌ`)과 조합 중간 상태(`맨ㅌ`, `맨트`)를 포함해 — 행에 바로 닿게 한다.

**Architecture:** 한글 음절 블록이 `0xAC00 + 초성×588 + 중성×28 + 종성`으로 배열된다는 성질을 써서, 질의 문자열을 정규식 하나로 컴파일하는 순수 함수(`compileQuery`)를 만든다. 두 리스트 컴포넌트는 그 정규식을 각 행의 haystack 문자열에 `.test()` 할 뿐이다. 검색창 UI는 두 리스트가 공유하는 작은 컴포넌트 하나.

**Tech Stack:** React 18, TypeScript, Tailwind v4, Vitest + @testing-library/react (jsdom). 새 런타임 의존성 없음.

**Spec:** `docs/superpowers/specs/2026-08-11-dashboard-list-search-design.md`

## Global Constraints

- 새 npm 의존성을 추가하지 않는다. 매처는 이 저장소 안의 순수 TypeScript다.
- 테스트는 저장소 루트에서 `pnpm vitest run <경로>` 로 돌린다. `web/tests/*.tsx`는 파일 첫 줄에 `// @vitest-environment jsdom` 이 필요하다 (`web/tests/TranslationList.test.tsx:1` 참고).
- 컴포넌트 테스트는 `@testing-library/react`의 `fireEvent`를 쓴다. `@testing-library/user-event`는 이 저장소에 설치되어 있지 않다.
- 검색창 placeholder는 정확히 `본문 · ID 검색`. `aria-label`은 정확히 `검색`, 지우기 버튼의 `aria-label`은 정확히 `검색어 지우기` — 테스트가 이 문자열로 요소를 찾는다.
- 탭 카운트는 언제나 그 탭이 실제로 보여줄 행의 수여야 한다 (`web/src/components/TranslationList.tsx:87`의 기존 계약).
- 커밋 메시지 제목은 영어, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` 로 끝난다 (`git log` 참고).

## File Structure

| 파일 | 책임 |
|---|---|
| `web/src/hangulSearch.ts` (신규) | 질의 문자열 → `RegExp \| null`. UI를 모른다. |
| `web/tests/hangulSearch.test.ts` (신규) | 매칭 규칙 전부. 로직의 무게가 여기 있다. |
| `web/src/components/SearchBox.tsx` (신규) | 입력 + 지우기 버튼 + Esc. 상태를 갖지 않는 제어 컴포넌트. |
| `web/tests/SearchBox.test.tsx` (신규) | 입력·지우기·Esc 동작. |
| `web/src/components/TranslationList.tsx` (수정) | 1차 배선. 검색이 행과 탭 카운트를 함께 좁힌다. |
| `web/tests/TranslationList.test.tsx` (수정) | 검색 케이스 추가. 기존 정렬 테스트는 건드리지 않는다. |
| `web/src/components/RenderingList.tsx` (수정) | 2차 배선. `ItemRow`에 `haystack` 추가. |
| `web/tests/RenderingList.test.tsx` (신규) | 아이템 행 단위 매칭, 필터와의 AND. |

---

### Task 1: 한글 매처

**Files:**
- Create: `web/src/hangulSearch.ts`
- Test: `web/tests/hangulSearch.test.ts`

**Interfaces:**
- Consumes: 없음 (이 저장소의 어떤 것도 import 하지 않는다)
- Produces: `compileQuery(query: string): RegExp | null` — 빈 질의/공백만인 질의는 `null`, 그 외에는 `i` 플래그가 붙은 `RegExp`. 호출부는 `null`을 "필터 없음"으로 읽는다. `g` 플래그는 절대 붙이지 않는다 (`lastIndex` 때문에 `.test()`가 호출마다 다른 답을 낸다).

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/hangulSearch.test.ts` 를 아래 내용으로 새로 만든다.

```ts
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
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run web/tests/hangulSearch.test.ts`
Expected: FAIL — `Failed to resolve import "../src/hangulSearch"`

- [ ] **Step 3: 매처 구현**

`web/src/hangulSearch.ts` 를 아래 내용으로 새로 만든다.

```ts
/**
 * 목록 검색용 한글 매처 — 질의 문자열 하나를 정규식 하나로 굽는다.
 *
 * 전부 U+AC00 블록의 배열 규칙 하나에서 나온다: 한글 음절은
 * `0xAC00 + 초성×588 + 중성×28 + 종성` 순으로 놓인다. 그래서
 *
 *  - 초성이 같은 음절 588자가 연속 범위다 (ㅁ → `마`..`밓`). 초성 검색이 곧 이 범위다.
 *  - 초성·중성이 같고 종성만 다른 음절 28자도 연속 범위다 (`타`..`탛`). "종성이 아직 안 붙은
 *    마지막 글자"가 곧 이 범위다.
 *  - 자모 테이블에서 합쳐질 수 있는 짝들이 서로 붙어 있다 (중성 ㅗ 다음이 ㅘ·ㅙ·ㅚ, 종성 ㄴ
 *    다음이 ㄵ·ㄶ). 그래서 "아직 더 자랄 수 있는 마지막 글자"도 범위 하나로 끝난다.
 *
 * 뒤의 두 성질이 필요한 이유는 IME다. React의 `onChange`는 한글 조합 중에도 중간값으로 발화하므로,
 * "맨틀"을 치는 동안 질의는 `ㅁ → 매 → 맨 → 맨ㅌ → 맨트 → 맨틀`을, "회의"를 치는 동안에는
 * `ㅎ → 호 → 회 → 회ㅇ → 회으 → 회의`를 지난다. 중간 상태가 안 걸리면 타이핑 도중 목록이 비었다가
 * 돌아온다. `compositionend`를 기다려 피하는 대신, 매처가 중간 상태를 이해하게 만들어 없앴다.
 *
 * 느슨한 것은 **마지막 조각뿐**이다. 중간 조각까지 열어주면 `마늘`이 `만늘`에 걸리는 식으로 뜻
 * 없이 넓어지는데, 조합이 진행 중일 수 있는 글자는 언제나 맨 끝 하나다.
 */

const BASE = 0xac00;
/** 마지막 음절 U+D7A3까지의 오프셋. */
const SYLLABLES = 11171;

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** 종성 인덱스 → 자모. 인덱스 0은 "종성 없음". */
const JONG = [
  "", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ",
  "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
];

/** 겹받침 → [앞 자모(종성에 남는다), 뒤 자모(다음 글자의 초성으로 넘어간다)]. */
const SPLIT: Record<string, [string, string]> = {
  "ㄳ": ["ㄱ", "ㅅ"], "ㄵ": ["ㄴ", "ㅈ"], "ㄶ": ["ㄴ", "ㅎ"], "ㄺ": ["ㄹ", "ㄱ"], "ㄻ": ["ㄹ", "ㅁ"],
  "ㄼ": ["ㄹ", "ㅂ"], "ㄽ": ["ㄹ", "ㅅ"], "ㄾ": ["ㄹ", "ㅌ"], "ㄿ": ["ㄹ", "ㅍ"], "ㅀ": ["ㄹ", "ㅎ"],
  "ㅄ": ["ㅂ", "ㅅ"],
};

/**
 * 홑받침 인덱스 → 그것이 자랄 수 있는 마지막 겹받침 인덱스.
 *
 * `JONG`에서 같은 자음으로 시작하는 받침들이 연달아 놓인 덕에 범위 하나로 끝난다: ㄴ(4)은 ㄵ(5)·
 * ㄶ(6)까지, ㄹ(8)은 ㅀ(15)까지. 여기 없는 인덱스는 자랄 곳이 없다는 뜻이다.
 */
const GROW: Record<number, number> = { 1: 3, 4: 6, 8: 15, 17: 18, 19: 20 };

/**
 * 홑모음 인덱스 → 그것이 자랄 수 있는 마지막 겹모음 인덱스. `GROW`와 같은 성질을 중성에서 쓴다:
 * ㅗ(8)는 ㅘ·ㅙ·ㅚ(9·10·11)까지, ㅜ(13)는 ㅟ(16)까지, ㅡ(18)는 ㅢ(19)까지.
 *
 * 이것이 없으면 "회의"를 치다 들르는 `호` 상태에서 결과가 사라진다.
 */
const JUNG_GROW: Record<number, number> = { 8: 11, 13: 16, 18: 19 };

const chr = String.fromCharCode;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");

/** 초성이 `c`인 음절 588자의 연속 범위. `c`가 초성이 될 수 없으면(ㄳ 등) null. */
function choRange(c: string): string | null {
  const i = CHO.indexOf(c);
  if (i === -1) return null;
  const b = BASE + i * 588;
  return `${chr(b)}-${chr(b + 587)}`;
}

const isSyllable = (c: string) => {
  const o = c.charCodeAt(0) - BASE;
  return o >= 0 && o <= SYLLABLES;
};

/** 질의의 한 글자 → 그 글자가 매치해야 할 정규식 조각. */
function pattern(c: string, last: boolean): string {
  if (/\s/.test(c)) return "\\s+";

  if (isSyllable(c)) {
    const o = c.charCodeAt(0) - BASE;
    const cho = Math.floor(o / 588);
    const jung = Math.floor((o % 588) / 28);
    const jong = o % 28;
    if (!last) return esc(c);

    const b = BASE + cho * 588 + jung * 28;
    // 종성이 아직 없다 — 어떤 종성이 붙어도 좋고, 중성이 겹모음으로 자랄 수도 있다(호 → 회).
    if (jong === 0) {
      const jMax = JUNG_GROW[jung] ?? jung;
      return `[${chr(b)}-${chr(BASE + cho * 588 + jMax * 28 + 27)}]`;
    }

    // 종성이 있다. 갈 수 있는 곳은 둘: 겹받침으로 자라거나(만 → 많), 다음 글자의 초성으로
    // 넘어가거나(간 → 가나).
    const kMax = GROW[jong] ?? jong;
    const grown = kMax === jong ? esc(c) : `[${chr(b + jong)}-${chr(b + kMax)}]`;
    const [rest, next] = SPLIT[JONG[jong]!] ?? ["", JONG[jong]!];
    const r = choRange(next);
    if (r === null) return grown;
    return `(?:${grown}|${esc(chr(b + JONG.indexOf(rest)))}[${r}])`;
  }

  // 홑자음이면 그 자음이 초성인 음절 전부, 또는 본문에 자모가 그대로 박혀 있는 경우를 위해 자기
  // 자신. 홑모음과 그 밖의 글자는 리터럴이다.
  const r = choRange(c);
  return r === null ? esc(c) : `[${r}${esc(c)}]`;
}

/**
 * 질의 → 정규식. 빈 질의(공백만인 경우 포함)는 `null`이고, 호출부는 그것을 "필터 없음"으로 읽는다.
 *
 * `g` 플래그는 붙이지 않는다 — `lastIndex`가 남아 같은 문자열에 대한 `.test()`가 호출마다 다른
 * 답을 내게 된다. `i`는 한글 범위에 영향이 없고 영문 대소문자만 무시한다.
 */
export function compileQuery(query: string): RegExp | null {
  const q = query.trim();
  if (q === "") return null;
  const chars = [...q];
  return new RegExp(chars.map((c, i) => pattern(c, i === chars.length - 1)).join(""), "i");
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run web/tests/hangulSearch.test.ts`
Expected: PASS — 13 tests

- [ ] **Step 5: 커밋**

```bash
git add web/src/hangulSearch.ts web/tests/hangulSearch.test.ts
git commit -m "$(cat <<'EOF'
feat(web): compile a search query into a Hangul-aware regex

The U+AC00 block puts every syllable sharing an initial consonant in one
contiguous run, and every syllable sharing 초성+중성 in another, so initial-
consonant search and "the last letter is still being composed" both fall out
as character ranges. Only the last chunk of a query is loose, which is where
an IME can still be mid-composition.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 검색창 컴포넌트

**Files:**
- Create: `web/src/components/SearchBox.tsx`
- Test: `web/tests/SearchBox.test.tsx`

**Interfaces:**
- Consumes: 없음
- Produces: `SearchBox(props: { value: string; onChange: (value: string) => void }): JSX.Element` — 상태를 갖지 않는 제어 컴포넌트. 지우기는 `onChange("")`로 알린다.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/SearchBox.test.tsx` 를 아래 내용으로 새로 만든다.

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchBox } from "../src/components/SearchBox";

afterEach(cleanup);

describe("SearchBox", () => {
  it("reports what was typed", () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("검색"), { target: { value: "ㅁㅌ" } });
    expect(onChange).toHaveBeenCalledWith("ㅁㅌ");
  });

  it("offers the clear button only when there is something to clear", () => {
    const { rerender } = render(<SearchBox value="" onChange={() => {}} />);
    expect(screen.queryByLabelText("검색어 지우기")).toBeNull();
    rerender(<SearchBox value="맨틀" onChange={() => {}} />);
    expect(screen.getByLabelText("검색어 지우기")).toBeTruthy();
  });

  it("clears on the button and on Escape", () => {
    const onChange = vi.fn();
    render(<SearchBox value="맨틀" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText("검색어 지우기"));
    expect(onChange).toHaveBeenLastCalledWith("");

    fireEvent.keyDown(screen.getByLabelText("검색"), { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run web/tests/SearchBox.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/SearchBox"`

- [ ] **Step 3: 컴포넌트 구현**

`web/src/components/SearchBox.tsx` 를 아래 내용으로 새로 만든다.

```tsx
/**
 * 1차와 2차 사이드바가 공유하는 검색 입력 한 줄. 상태는 갖지 않는다 — 어느 목록이 무엇으로
 * 좁혀졌는지는 그 목록의 일이다.
 *
 * 테두리·라운드·`focus:border-mint`는 `RenderingList.tsx`의 `selectClass`와 같은 값이다. 2차
 * 헤더에서 이 입력은 채널·타입 셀렉트 바로 아래 줄에 서므로, 둘의 테두리가 다르면 눈에 띈다.
 * 그 문자열을 import 하지는 않는다 — 공용 컴포넌트가 2차 전용 파일에 의존하게 된다.
 *
 * `type="search"`가 아니라 `type="text"`인 것은 의도다. WebKit이 search 입력에 자기 지우기
 * 버튼을 그려서, 아래 × 옆에 하나가 더 생긴다.
 */
export function SearchBox(props: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="relative">
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onChange("");
        }}
        placeholder="본문 · ID 검색"
        // 초성 힌트는 placeholder에 넣지 않는다 — `w-80` 사이드바에서 잘리고, 잘린 힌트는 힌트가
        // 아니다. 여기서는 잘리지 않는다.
        title="초성으로도 찾습니다 — ㅁㅌ 로 맨틀. 치는 도중(맨ㅌ, 맨트)에도 걸립니다."
        aria-label="검색"
        className="w-full rounded-lg border border-line bg-surface py-1 pl-2 pr-7 text-[13px] text-ink outline-none placeholder:text-faint focus:border-mint"
      />
      {props.value !== "" && (
        <button
          type="button"
          onClick={() => props.onChange("")}
          aria-label="검색어 지우기"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-[15px] leading-none text-faint transition-colors hover:text-ink"
        >
          ×
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run web/tests/SearchBox.test.tsx`
Expected: PASS — 3 tests

- [ ] **Step 5: 커밋**

```bash
git add web/src/components/SearchBox.tsx web/tests/SearchBox.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the search input both review sidebars will share

Stateless and controlled: the input reports what was typed and asks to be
cleared, and which list narrowed to what stays with that list. Escape clears
as well as the button, and the initial-consonant hint lives in the title
rather than a placeholder that a w-80 column would truncate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 1차 배선

**Files:**
- Modify: `web/src/components/TranslationList.tsx:82-111`
- Test: `web/tests/TranslationList.test.tsx` (기존 파일에 추가)

**Interfaces:**
- Consumes: `compileQuery` (Task 1), `SearchBox` (Task 2)
- Produces: 없음 — `TranslationList`의 props는 그대로다 (`items`, `selectedId`, `onSelect`).

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/TranslationList.test.tsx` 의 import 줄을 아래로 바꾼다 (`fireEvent` 추가).

```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
```

그리고 파일 **맨 끝**에 아래를 덧붙인다. 기존 `describe("TranslationList order", ...)`와 헬퍼
`t()`·`shownIds()`는 건드리지 않는다.

```tsx
/** 검색창에 값을 넣는다 — IME 조합 중에도 React가 보는 것과 같은 경로(onChange). */
const type = (value: string) => fireEvent.change(screen.getByLabelText("검색"), { target: { value } });

describe("TranslationList search", () => {
  const items = [
    t({ itemId: "x:1", koreanText: "맨틀 네트워크 메인넷 업데이트" }),
    t({ itemId: "x:2", koreanText: "이더리움 수수료 이야기" }),
    t({ itemId: "x:3", koreanText: "코스모스 소식", status: "approved" }),
  ];

  it("narrows the rows by initial consonants", () => {
    const { container } = render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("ㅁㅌ");
    expect(shownIds(container)).toEqual(["x:1"]);
  });

  /**
   * `count()`가 `props.items` 위에서 돌면 `전체 3`이 뜬 채 한 줄만 보인다 — 카운트가 생긴 이유였던
   * 착시가 그대로 돌아온다. 이 컴포넌트의 주석이 계약으로 적어둔 바로 그것.
   */
  it("narrows the tab counts with the rows", () => {
    render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "전체 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "승인 1" })).toBeTruthy();

    type("ㅁㅌ");

    expect(screen.getByRole("button", { name: "전체 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "승인 0" })).toBeTruthy();
  });

  it("finds a row by its English source when the Korean does not say it", () => {
    const { container } = render(
      <TranslationList
        items={[t({ itemId: "x:9", koreanText: "한국어 본문", sourceText: "Mantle mainnet is live" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("mainnet");
    expect(shownIds(container)).toEqual(["x:9"]);
  });

  it("finds a row by the itemId a reviewer pasted in", () => {
    const { container } = render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("x:2");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("says nothing matched rather than showing a stale list", () => {
    render(<TranslationList items={items} selectedId={null} onSelect={() => {}} />);
    type("ㅋㅋㅋㅋ");
    expect(screen.getByText("해당하는 항목이 없습니다.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run web/tests/TranslationList.test.tsx`
Expected: FAIL — `Unable to find a label with the text of: 검색` (5개 새 테스트가 모두 실패, 기존 정렬 테스트는 통과)

- [ ] **Step 3: 구현**

`web/src/components/TranslationList.tsx` 의 import 두 줄을 아래로 바꾼다.

```tsx
import { useState } from "react";
import { compileQuery } from "../hangulSearch";
import { datePrefix, type Translation } from "../types";
import { SearchBox } from "./SearchBox";
```

`TranslationList` 본문에서 `const [filter, setFilter] = useState<Filter>("all");` 부터
`const count = ...` 까지를 아래로 바꾼다 (기존 주석 블록은 그대로 살린다).

```tsx
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const matches = (t: Translation, f: Filter) => f === "all" || t.status === f;
  /**
   * 검색 대상은 `preview()`가 쓰는 `koreanText || sourceText`가 아니라 **둘 다**이다. 번역이 붙은
   * 뒤에도 영문 원문의 단어로 찾을 수 있어야 하고, 검수자가 기억하는 구절이 어느 쪽 언어일지는
   * 정해져 있지 않다. `itemId`는 링크를 타고 온 id를 그대로 붙여넣는 경로를 위해.
   */
  const re = compileQuery(search);
  const found = re === null ? props.items : props.items.filter((t) => re.test(`${t.itemId} ${t.koreanText} ${t.sourceText}`));
  // Copied before sorting: `props.items` is App's state array, and sorting in place would mutate it.
  const shown = found.filter((t) => matches(t, filter)).slice().sort(newestFirst);
  /**
   * Same predicate as `shown`, so a tab can never promise a row it does not then show.
   *
   * The counts exist because the labels alone made a finished queue look like a full one: once
   * reconcile started retiring hand-published items to `posted`, 전체 could read 23 while 검수 대기
   * held 2, and the only way to learn that was to click. `pnpm status` had the same blind spot on
   * the same data (`src/status/pipeline.ts`).
   *
   * 검색 중에도 같은 계약이다 — `props.items`가 아니라 `found` 위에서 센다. 아니면 `전체 23`이 뜬
   * 채 아래에 두 줄만 보이고, 카운트가 생긴 이유였던 착시가 그대로 돌아온다.
   */
  const count = (f: Filter) => found.filter((t) => matches(t, f)).length;
```

sticky 헤더의 여는 `<div>` 에 `space-y-2` 를 넣고, 탭 줄을 닫는 `</div>` 바로 뒤에 `SearchBox` 를 놓는다.

```tsx
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface/90 px-3 py-2.5 backdrop-blur">
        <div className="inline-flex w-full rounded-lg border border-line bg-bg p-0.5">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`flex-1 whitespace-nowrap rounded-[7px] px-2 py-1 text-[12px] font-medium transition-colors ${
                filter === f ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {label} <span className="font-mono text-[11px] tabular-nums text-faint">{count(f)}</span>
            </button>
          ))}
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run web/tests/TranslationList.test.tsx`
Expected: PASS — 기존 정렬 테스트 + 새 검색 테스트 5개

- [ ] **Step 5: 커밋**

```bash
git add web/src/components/TranslationList.tsx web/tests/TranslationList.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): search the 1차 sidebar by text, id, or initial consonants

The tabs answered what is left but never where a specific item is, so the only
way to reach one was scrolling. Search runs over the itemId and both languages
of the body, and the tab counts run over the searched set — otherwise 전체 23
sits above two visible rows, which is the illusion the counts were added to end.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 2차 배선

**Files:**
- Modify: `web/src/components/RenderingList.tsx:16-31` (`ItemRow`), `:39-60` (`toItemRows`), `:70-118` (컴포넌트 본문과 헤더)
- Test: `web/tests/RenderingList.test.tsx` (신규)

**Interfaces:**
- Consumes: `compileQuery` (Task 1), `SearchBox` (Task 2)
- Produces: `ItemRow`에 `haystack: string` 필드 추가. `toItemRows(renderings: Rendering[]): ItemRow[]` 의 시그니처는 그대로다.

- [ ] **Step 1: 실패하는 테스트 작성**

`web/tests/RenderingList.test.tsx` 를 아래 내용으로 새로 만든다.

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RenderingList } from "../src/components/RenderingList";
import type { Rendering } from "../src/types";

afterEach(cleanup);

function r(over: Partial<Rendering> & { itemId: string }): Rendering {
  return {
    type: "announcement",
    channel: "telegram",
    text: "본문",
    refined: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "rendered",
    convertedText: "",
    ...over,
  };
}

/** 목록에 남은 아이템 id들. 행 버튼만 `x:`를 담는다 (검색창도 지우기 버튼도 담지 않는다). */
function shownIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .filter((s) => s.includes("x:"))
    .map((s) => /x:\d+/.exec(s)?.[0] ?? "");
}

const type = (value: string) => fireEvent.change(screen.getByLabelText("검색"), { target: { value } });

describe("RenderingList search", () => {
  /**
   * 한 아이템의 카드는 여러 장이고 미리보기는 첫 장뿐이다. 오픈카톡 카드에만 있는 문구로 검색해도
   * 행이 남아야 한다 — 행의 역할은 보드를 여는 것이지 매치를 증명하는 것이 아니다.
   */
  it("keeps an item whose match is on a card the preview does not show", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", type: "announcement", channel: "telegram", text: "텔레그램 공지 문구" }),
          r({ itemId: "x:1", type: "announcement", channel: "kakao", text: "카카오에만 있는 에어드랍 안내" }),
          r({ itemId: "x:2", text: "관계없는 다른 아이템" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("에어드랍");
    expect(shownIds(container)).toEqual(["x:1"]);
  });

  it("matches by initial consonants and by itemId", () => {
    const { container } = render(
      <RenderingList
        items={[r({ itemId: "x:1", text: "맨틀 네트워크 공지" }), r({ itemId: "x:2", text: "다른 소식" })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    type("ㅁㅌ");
    expect(shownIds(container)).toEqual(["x:1"]);
    type("x:2");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("ands with the channel filter rather than replacing it", () => {
    const { container } = render(
      <RenderingList
        items={[
          r({ itemId: "x:1", channel: "telegram", text: "맨틀 텔레그램" }),
          r({ itemId: "x:2", channel: "kakao", text: "맨틀 카카오" }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );
    fireEvent.change(screen.getByDisplayValue("모든 채널"), { target: { value: "kakao" } });
    type("맨틀");
    expect(shownIds(container)).toEqual(["x:2"]);
  });

  it("says nothing matched rather than showing a stale list", () => {
    render(<RenderingList items={[r({ itemId: "x:1", text: "맨틀" })]} selectedId={null} onSelect={() => {}} />);
    type("ㅋㅋㅋㅋ");
    expect(screen.getByText("해당하는 항목이 없습니다.")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run web/tests/RenderingList.test.tsx`
Expected: FAIL — `Unable to find a label with the text of: 검색` (4개 모두)

- [ ] **Step 3: 구현**

`web/src/components/RenderingList.tsx` 의 import 세 줄을 아래로 바꾼다.

```tsx
import { useState } from "react";
import { compileQuery } from "../hangulSearch";
import { ALL_CHANNELS, ALL_TYPES, CHANNEL_LABEL, TYPE_LABEL, datePrefix, type Rendering } from "../types";
import { SearchBox } from "./SearchBox";
import { KindBadge } from "./TranslationList";
```

`ItemRow` 의 `preview: string;` 아래에 필드를 하나 더한다.

```tsx
  preview: string;
  /**
   * 검색이 훑는 문자열 — itemId와 이 아이템의 **모든** 카드 문구. `preview`는 첫 카드뿐이라,
   * 오픈카톡 카드에만 있는 문구로 검색하면 행은 뜨지만 미리보기에는 그 문구가 안 보일 수 있다.
   * 감수하는 성질이다: 행의 역할은 보드를 여는 것이지 매치를 증명하는 것이 아니고, 카드마다 행을
   * 나누는 대안은 이 파일 위쪽 `ItemRow` 주석이 이미 기각했다.
   */
  haystack: string;
```

`toItemRows` 의 반환 객체에서 `preview` 줄 아래에 한 줄을 더한다.

```tsx
      preview: (ordered[0]?.text ?? "").replace(/\s+/g, " ").trim(),
      haystack: [itemId, ...ordered.map((r) => r.text)].join(" "),
```

컴포넌트 본문에서 `const [type, setType] = ...` 아래에 검색 상태를 더하고, `const shown = toItemRows(matching);` 를 바꾼다.

```tsx
  const [type, setType] = useState<"all" | Rendering["type"]>("all");
  const [search, setSearch] = useState("");

  // Filters still read per rendering — "items that have an approved 공지 for telegram" — but they
  // now decide which *items* are listed, because that is what the row stands for.
  const matching = props.items.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (channel === "all" || r.channel === channel) &&
      (type === "all" || r.type === type),
  );
  // 검색은 셀렉트 필터가 좁힌 집합 위에서, 아이템 행 단위로 걸린다 — 셋 다 AND다.
  const re = compileQuery(search);
  const rows = toItemRows(matching);
  const shown = re === null ? rows : rows.filter((row) => re.test(row.haystack));
```

헤더의 타입 셀렉트를 감싼 `</div>` 바로 뒤, sticky 헤더를 닫는 `</div>` 바로 앞에 검색창을 놓는다
(헤더는 이미 `space-y-2` 이므로 클래스는 손대지 않는다).

```tsx
        </div>
        <SearchBox value={search} onChange={setSearch} />
      </div>
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run web/tests/RenderingList.test.tsx`
Expected: PASS — 4 tests

- [ ] **Step 5: 전체 검증**

Run: `pnpm typecheck:web && pnpm vitest run web/tests && pnpm build:web`
Expected: 타입 오류 없음, `web/tests` 전부 통과, 빌드 성공

`toItemRows` 는 이 저장소의 다른 곳에서도 쓰일 수 있다. `haystack` 은 새로 더한 필수 필드이므로,
타입체크가 통과하지 않으면 그 호출부부터 본다.

- [ ] **Step 6: 커밋**

```bash
git add web/src/components/RenderingList.tsx web/tests/RenderingList.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): search the 2차 sidebar across every card an item has

An item's row stands for the whole board, so search matches any of its card
texts, not just the first one the preview shows. It runs after the status,
channel and type filters, so narrowing by channel and then searching stays
inside that channel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**스펙 커버리지**

| 스펙 절 | 구현 |
|---|---|
| 매칭 규칙표 8줄 전부 | Task 1 Step 3 `pattern()` |
| 겹받침 성장 / 종성→다음 초성 | Task 1 Step 3 `GROW`, `SPLIT` |
| 겹모음 성장 (`호` → 회) | Task 1 Step 3 `JUNG_GROW` |
| `compile(query) → RegExp \| null` | Task 1 (이름은 `compileQuery`) |
| SearchBox placeholder·×·Esc·`title` | Task 2 |
| `selectClass`를 import 하지 않고 같은 값 사용 | Task 2 Step 3 (주석에 명시) |
| 1차 haystack = itemId + koreanText + sourceText | Task 3 Step 3 |
| 1차 탭 카운트가 검색을 따른다 | Task 3 Step 1(테스트) + Step 3 |
| 2차 haystack = itemId + 모든 렌더링 text | Task 4 Step 3 |
| 2차 필터와 AND | Task 4 Step 1(테스트) + Step 3 |
| 빈 결과 문구는 기존 문장 그대로 | Task 3·4의 마지막 테스트가 지킨다 |
| 테스트 목록 전부 | Task 1·3·4 |
| 디바운스/보존/하이라이트/퍼지 없음 | 어느 태스크에도 없다 |

스펙이 `compile`이라 부른 함수는 계획 전체에서 `compileQuery`다 — `compile`은 이름만으로 무엇을
굽는지 말하지 않는다.

**이름 일관성**: `compileQuery`, `SearchBox`, `haystack`, `found`, `rows`, `shown` — Task 1의
반환 타입(`RegExp | null`)과 Task 3·4의 `re === null` 분기가 맞는다. `ItemRow.haystack`은 Task 4
안에서만 쓰인다.
