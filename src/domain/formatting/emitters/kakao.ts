import { flattenPostBoundaries, linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/**
 * Past this, KakaoTalk folds the bubble behind a 「전체보기」 button and the body is hidden until
 * the reader taps it. Kakao's own CS spec: "단일형 버튼 미사용시 : 1,000자(500자 초과시 전체보기
 * 버튼을 통해 확인가능)". https://cs.kakao.com/helps_html/1073201585?locale=ko
 *
 * KakaoTalk copy is never threaded — unlike X, it is always exactly one message, so going over
 * this limit is never fixed by splitting. It is only ever fixed by writing less.
 */
export const KAKAO_FOLD = 500;

/**
 * A line-leading `- ` list marker, and only that. The space is what makes it a marker: `---` (this
 * pipeline's post separator) and `-30%` (a figure) both start a line with a hyphen and are neither.
 * Indentation is captured so a nested item keeps the shape it was written with.
 */
const BULLET_MARKER = /^([ \t]*)- /gm;

/**
 * Render list markers as the bullet the reader actually sees.
 *
 * KakaoTalk parses no markup, so a `-` typed as a list marker arrives as a literal hyphen sitting in
 * the message — it reads as a dash, not as a list. `conversion/kakao_notice.md` §4 has the writer
 * type `- 항목: 값`, which is the right thing to write in shared canonical text; turning it into
 * something a bare-text client displays as a list is this emitter's job, the same way
 * `stripLinkIcon` is the x emitter's.
 *
 * One character for one character, so it can never push a notice over the 500-character fold.
 *
 * Exported for its own tests; `emitKakaoPaste` below is the only production caller.
 */
export function dotBullets(text: string): string {
  return text.replace(BULLET_MARKER, "$1• ");
}

/** KakaoTalk parses no markup of any kind and its composer offers no formatting. */
export function emitKakaoPaste(canonical: string): EmitResult {
  const text = linksToPlain(stripBold(dotBullets(flattenPostBoundaries(canonical))));
  const length = [...text].length;
  const overLimit = length > KAKAO_FOLD;
  return {
    segments: [{ text, length, limit: KAKAO_FOLD, overLimit }],
    warnings: overLimit
      ? [`${length}/${KAKAO_FOLD}자 — 「전체보기」로 접힙니다. 카카오는 한 통으로 나가니 줄여야 합니다`]
      : [],
  };
}
