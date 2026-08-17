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
 * `ConfirmDialog.tsx`의 취소/확인 두 버튼은 파일 하나에 한 번씩만 있다 — `buttonStyles.ts`가 막으려는
 * "여러 파일에 흩어진 사본이 따로 썩는다"는 위험이 여기엔 없다(비교: `TranslationDetail.tsx`/
 * `OutletCard.tsx`는 이미 buttonStyles.ts를 가져다 쓰는 다른 버튼들과 나란히, 손으로 다시 쓴 사본을
 * 갖고 있었다 — 그게 진짜 문제였다). `확인`은 danger 여부로 색이 갈리는데 mint 쪽만 `btnPrimary`와
 * 맞고 solid red 쪽은 이 한 곳에만 쓰여 새 export를 정당화하지 못한다 — 그래서 이 파일은 이 가드에서
 * 통째로 뺀다. 새 버튼이 여기 생기면 이 예외가 가려버리므로, 이 파일을 고칠 때는 사람이 직접
 * `buttonStyles.ts`와 대조해야 한다.
 */
const EXEMPT_FILES = ["ConfirmDialog.tsx"];

/** `<button` 태그 하나에 딸린 className 리터럴(따옴표 문자열이든, 템플릿 리터럴이든, 그 템플릿이
 *  `{}`로 한 번 더 감싸여 있든)을 뽑는다. `className={someExport}`처럼 식별자 하나뿐이면 훑을 리터럴이
 *  없다는 뜻이므로 건너뛴다 — 그런 경우는 이미 공유 export를 쓰고 있다는 신호다. */
function extractButtonClassNames(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/<button\b/g)) {
    const start = m.index;
    const nextTag = source.indexOf("<", start + 1);
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
  for (const path of walk(SRC).filter(
    (p) =>
      (p.endsWith(".tsx") || p.endsWith(".ts")) &&
      !p.endsWith("buttonStyles.ts") &&
      !EXEMPT_FILES.some((f) => p.endsWith(f)),
  )) {
    const source = readFileSync(path, "utf8");
    for (const cls of extractButtonClassNames(source)) {
      if (GEOMETRY_FINGERPRINT.every((token) => cls.includes(token))) {
        offenders.push(`${path.replace(SRC, "web/src")}: "${cls}"`);
      }
    }
  }
  expect(
    offenders,
    "이 <button>들이 buttonStyles.ts의 BASE 지오메트리(px-3.5/py-1.5/text-[13px])를 손으로 다시 " +
      "베꼈다 — 고칠 방법: 색이 `btn`/`btnPrimary`/`btnDanger`/`btnApprove`/`btnApproved` 중 하나와 " +
      "맞으면 그 export를 import해서 쓰고, 정말 새로운 배색이면 buttonStyles.ts에 export를 새로 " +
      "추가하라. 한 파일에만 있는 진짜 일회성이면(여러 파일이 따로 썩는 위험이 없으면) EXEMPT_FILES에 " +
      "이유와 함께 올려라.",
  ).toEqual([]);
});
