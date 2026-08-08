import { FLOOR_VAR, WATCH_UNIT, type CollectedReach, type IntakeTerm } from "./types";

/**
 * The Korean half of the intake funnel. The server sends terms, not text (`IntakeTerm`), so the CLI
 * can print `223 X threads - 92 replies dropped + 3 Lark` while this screen prints the same three
 * numbers in Korean — one sum, two wordings, and no way for the two to end up describing different
 * arithmetic.
 *
 * "제외" rather than "삭제": a reply-rooted thread was never deleted, it was filtered out before it
 * could become an item (`isCommenterReply`), and a reviewer who reads it as deletion goes looking
 * for something to restore.
 */
export const INTAKE_TERM_LABEL: Record<IntakeTerm["kind"], string> = {
  threads: "수집한 X 스레드",
  "replies-dropped": "답글로 시작해 제외",
  lark: "Lark 항목",
};

/** `223` · `-92` · `+3` — the operator travels with the term rather than being re-derived from its
 *  kind here, so a card can never sum differently than the line `pnpm status` prints. */
export const intakeTermAmount = (term: IntakeTerm): string => `${term.op ?? ""}${term.count}`;

/**
 * What the card says about the scheduler's translation floor — the second half of the breakdown, and
 * the half whose reach is not universal.
 *
 * Three states because `CollectedReach` has three, and collapsing any two of them is the mistake
 * this whole area exists to prevent:
 *
 * - `measured` — a floor is set and both sides of it were counted.
 * - `no-floor` — the unit runs with none. `alarming`, and worded as a condition rather than as a
 *   missing setting: it means every tick works the oldest posts in the archive first.
 * - `unknown` — this screen could not ask. Neutral, and what the hosted dashboard shows always,
 *   because a Vercel function has no systemd. The sentence must land as "cannot be seen from here";
 *   a reader who takes it as "there is no floor" has been told the opposite of the truth.
 */
export interface ReachCopy {
  /** The one-line verdict, in the same shape as the CLI's `in scope 20 · below floor 114`. */
  headline: string;
  /** What that means for the queue — the sentence a bare pair of numbers does not say. */
  detail: string;
  /** Something an operator has to act on. The ⚠ the CLI prints on the same state. */
  alarming: boolean;
  /** The floor instant (ISO), when there is one to show. Rendered, not interpolated, so a scope
   *  measured without a named floor prints one line fewer rather than the word `undefined`. */
  floor?: string;
  /** systemd's own words for why it could not answer. Never the only thing shown. */
  refusal?: string;
}

export function reachCopy(reach: CollectedReach): ReachCopy {
  switch (reach.kind) {
    case "measured":
      return {
        headline: `번역 대상 ${reach.inScope}건 · 하한 아래 ${reach.belowFloor}건`,
        detail: `하한보다 오래된 수집 항목은 스케줄러(${WATCH_UNIT})가 선택하지 않습니다.`,
        alarming: false,
        floor: reach.floor,
      };
    case "no-floor":
      return {
        headline: `번역 대상 ${reach.inScope}건 · 하한 없음`,
        detail:
          `${WATCH_UNIT}는 실행 중이지만 ${FLOOR_VAR}가 없습니다 — ` +
          `수집된 전부가 오래된 것부터 번역 대상입니다.`,
        alarming: true,
      };
    case "unknown":
      return {
        headline: "번역 대상 알 수 없음",
        detail:
          `이 화면에서는 ${WATCH_UNIT}의 설정을 읽을 수 없습니다 — ` +
          `하한이 없다는 뜻이 아니라, 여기서 확인할 수 없다는 뜻입니다. ` +
          `실제 하한은 스케줄러가 도는 서버에서 pnpm status로 확인하세요.`,
        alarming: false,
        refusal: reach.detail,
      };
  }
}
