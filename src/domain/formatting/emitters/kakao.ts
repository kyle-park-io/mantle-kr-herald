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

/** KakaoTalk parses no markup of any kind and its composer offers no formatting. */
export function emitKakaoPaste(canonical: string): EmitResult {
  const text = linksToPlain(stripBold(flattenPostBoundaries(canonical)));
  const length = [...text].length;
  const overLimit = length > KAKAO_FOLD;
  return {
    segments: [{ text, length, limit: KAKAO_FOLD, overLimit }],
    warnings: overLimit
      ? [`${length}/${KAKAO_FOLD}자 — 「전체보기」로 접힙니다. 카카오는 한 통으로 나가니 줄여야 합니다`]
      : [],
  };
}
