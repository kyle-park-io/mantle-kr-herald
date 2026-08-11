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
 * 컴파일하기 전에 질의 안의 연속된 공백은 하나로 뭉친다. `pattern()`은 공백 문자 하나마다
 * `\s+` 조각 하나를 내놓으므로, 뭉치지 않으면 질의의 공백 N개가 정규식에 나란한 `\s+` N개로
 * 남는다. 이것이 두 가지로 문제다. 하나는 결과가 틀린다는 것 — 나란한 `\s+`는 본문에도 공백이
 * N개 **이상** 있어야 한다는 뜻이 되어 지나치게 좁아진다(브라우저에서 두 줄을 복사하면 그
 * 사이에 `\n\n`이 들어가는데, 저장된 본문은 줄바꿈 하나뿐인 식으로 실제로 부딪힌다). 다른
 * 하나는 성능이다 — 나란한 `\s+` N개가 길이 L짜리 공백 구간과 만나면 정규식 엔진이 시도할 나눔의
 * 수가 C(L,N)으로 폭발한다(질의에 공백 8개, 본문에 공백 40자면 10초 단위). `compileQuery`는
 * 매 렌더마다, 즉 매 키 입력마다 동기로 도는 함수이므로 이는 곧 탭이 멈추는 것과 같다.
 *
 * `g` 플래그는 붙이지 않는다 — `lastIndex`가 남아 같은 문자열에 대한 `.test()`가 호출마다 다른
 * 답을 내게 된다. `i`는 한글 범위에 영향이 없고 영문 대소문자만 무시한다.
 */
export function compileQuery(query: string): RegExp | null {
  const q = query.trim().replace(/\s+/g, " ");
  if (q === "") return null;
  const chars = [...q];
  return new RegExp(chars.map((c, i) => pattern(c, i === chars.length - 1)).join(""), "i");
}
