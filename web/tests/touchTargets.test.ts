import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

const SRC = join(__dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * `BASE`의 지오메트리는 arbitrary 값 셋(3.5/1.5 패딩 + 13px 글자)이 한 버튼에 같이 나타난다는
 * 사실로 알아본다 — `rounded-lg`·`font-medium`·`transition-colors` 낱개는 이 코드베이스 다른
 * 곳에도 흔해서 지문이 못 된다. 이 셋이 같이 나타나면 `buttonStyles.ts`를 베낀 것이다: import하지
 * 않고 값을 손으로 다시 쳤다는 뜻.
 */
const GEOMETRY_FINGERPRINT = ["px-3.5", "py-1.5", "text-[13px]"];

/**
 * 파일 통째가 아니라 클래스 문자열 자체로 예외를 건다 — 그래야 이 파일에 새 손 카피 버튼이 생겨도
 * 가려지지 않는다. 줄바꿈·들여쓰기 차이는 무시하도록 비교 전에 공백을 한 칸으로 접는다(아래
 * `normalize`); 그래서 이 문자열이 조금이라도 "내용이" 바뀌면(포맷팅 말고) 다시 걸린다 — 리뷰 없이
 * 조용히 계속 봐주는 일은 없다.
 *
 * `ConfirmDialog.tsx`의 `확인` 하나만 여기 있다. `취소`는 `btn`과 색이 정확히 같아 이제 그 export를
 * import해서 쓴다(더는 손 카피가 아니라 이 목록에 없다). `확인`은 danger 여부로 색이 갈리는데 mint
 * 쪽만 `btnPrimary`와 맞고 solid red 쪽은 이 한 곳에만 쓰여 새 export를 정당화하지 못한다 — 파일
 * 하나에 한 번뿐이라 `buttonStyles.ts`가 막으려는 "여러 파일에 흩어진 사본이 따로 썩는다"는 위험도
 * 없다(비교: `TranslationDetail.tsx`/`OutletCard.tsx`는 이미 buttonStyles.ts를 가져다 쓰는 다른
 * 버튼들과 나란히 손으로 다시 쓴 사본을 갖고 있었다 — 그게 진짜 문제였다).
 */
const EXEMPT: { file: string; className: string }[] = [
  {
    file: "ConfirmDialog.tsx",
    className:
      'rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors pointer-coarse:min-h-11 ${ danger ? "bg-red-600 hover:bg-red-700" : "bg-mint hover:bg-mint-hover" }',
  },
];

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * "다음 태그가 어디서 시작하는가"를 아무 `<`나 잡아서 답하면 뚫린다: `disabled={n < 3}`처럼 JSX
 * 표현식 안의 비교 연산자도 `<`다. 이 저장소(그리고 Prettier 기본값)의 스타일은 비교 연산자
 * 앞뒤에 공백을 두므로(`n < 3`, `i < len`), 실제 태그 시작(`<button`, `</div`, `<Icon`, …)만 골라내는
 * 값싼 방법은 "`<` 바로 뒤에 공백이 아니라 글자·`/`가 오는" 자리만 taggerdms 후보로 본다.
 */
function findNextTagOpen(source: string, from: number): number {
  const rest = source.slice(from);
  const m = /<[a-zA-Z/]/.exec(rest);
  return m ? from + m.index : -1;
}

/** `<button` 태그 하나에 딸린 className 리터럴(따옴표 문자열이든, 템플릿 리터럴이든, 그 템플릿이
 *  `{}`로 한 번 더 감싸여 있든)을 뽑는다. `className={someExport}`처럼 식별자 하나뿐이면 훑을 리터럴이
 *  없다는 뜻이므로 건너뛴다 — 그런 경우는 이미 공유 export를 쓰고 있다는 신호다. */
function extractButtonClassNames(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/<button\b/g)) {
    const start = m.index;
    const nextTag = findNextTagOpen(source, start + 1);
    const clsIdx = source.indexOf("className=", start);
    if (clsIdx === -1 || (nextTag !== -1 && clsIdx > nextTag)) continue;
    const afterEq = clsIdx + "className=".length;
    const opener = source[afterEq];
    if (opener === '"') {
      const end = source.indexOf('"', afterEq + 1);
      found.push(source.slice(afterEq + 1, end));
    } else if (opener === "`") {
      const end = source.indexOf("`", afterEq + 1);
      found.push(source.slice(afterEq + 1, end));
    } else if (opener === "{") {
      const backtick = source.indexOf("`", afterEq);
      const braceClose = source.indexOf("}", afterEq);
      if (backtick !== -1 && (braceClose === -1 || backtick < braceClose)) {
        const end = source.indexOf("`", backtick + 1);
        found.push(source.slice(backtick + 1, end));
      }
    }
  }
  return found;
}

it("BASE의 지오메트리를 손으로 다시 베낀 <button>이 없다", () => {
  const offenders: string[] = [];
  for (const path of walk(SRC).filter((p) => (p.endsWith(".tsx") || p.endsWith(".ts")) && !p.endsWith("buttonStyles.ts"))) {
    const shortPath = path.replace(SRC, "web/src");
    const source = readFileSync(path, "utf8");
    for (const cls of extractButtonClassNames(source)) {
      if (!GEOMETRY_FINGERPRINT.every((token) => cls.includes(token))) continue;
      const exempted = EXEMPT.some((e) => path.endsWith(e.file) && normalize(cls) === normalize(e.className));
      if (exempted) continue;
      offenders.push(`${shortPath}: "${cls}"`);
    }
  }
  expect(
    offenders,
    "이 <button>들이 buttonStyles.ts의 BASE 지오메트리(px-3.5/py-1.5/text-[13px])를 손으로 다시 " +
      "베꼈다 — 고칠 방법: 색이 `btn`/`btnPrimary`/`btnDanger`/`btnApprove`/`btnApproved` 중 하나와 " +
      "맞으면 그 export를 import해서 쓰고, 정말 새로운 배색이면 buttonStyles.ts에 export를 새로 " +
      "추가하라. 한 파일에 한 번뿐인 진짜 일회성이면(여러 파일이 따로 썩는 위험이 없으면) EXEMPT에 " +
      "정확한 클래스 문자열과 이유를 함께 올려라 — 파일 전체가 아니라 그 버튼 하나만 빠지도록.",
  ).toEqual([]);
});
