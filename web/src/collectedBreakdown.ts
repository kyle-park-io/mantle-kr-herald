import { FLOOR_VAR, WATCH_UNIT, kstStamp, type CollectedReach, type IntakeTerm } from "./types";

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
 * How old a scheduler report may get before the card treats it as evidence the scheduler stopped.
 *
 * Six hours, from the timer rather than from taste: `deploy/herald-watch.timer` fires
 * `OnCalendar=*-*-* 0/2:17:00`, so a healthy report is at most two hours old plus however long the
 * tick that wrote it took to start. Three missed fires is well past any slow tick and comfortably
 * short of a working day — an operator who opens the board in the morning and sees a report from
 * before they went home learns something, which is the whole point of showing the age.
 */
export const REPORT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * `방금 전` / `37분 전` / `5시간 전` / `22일 전` — how long ago the scheduler wrote its report.
 *
 * The card's whole obligation for a reported floor: a report from an hour ago and one from three
 * weeks ago carry the same number and mean completely different things, and only this line tells
 * them apart. Coarse on purpose — nobody acts on the difference between 37 and 38 minutes, and a
 * ticking seconds counter in a hover card is noise.
 *
 * A negative age is clamped to `방금 전` rather than printed as `-1분 전`: this project's own build
 * machine steps its clock by ±22.7s (WSL2 plus timesyncd both correcting it), and the report is
 * stamped on a different machine than the one rendering this, so a report a few seconds "in the
 * future" is ordinary rather than a fault worth showing anybody.
 */
export function reportAge(at: string, now: Date): string {
  const ms = now.getTime() - new Date(at).getTime();
  // An unparseable instant: say so rather than printing `NaN일 전`. Unreachable through the real
  // pipeline (the writer stamps `Date.prototype.toISOString`), which is exactly why it must not be
  // the branch that renders garbage if it ever becomes reachable.
  if (Number.isNaN(ms)) return "시각 불명";
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** Whether a report is old enough that the scheduler has most likely stopped — see
 *  `REPORT_STALE_AFTER_MS`. An unparseable or future instant is not stale: neither is evidence of a
 *  scheduler that stopped, and claiming it is would put a false alarm on the card. */
function isStaleReport(at: string, now: Date): boolean {
  const ms = now.getTime() - new Date(at).getTime();
  return !Number.isNaN(ms) && ms > REPORT_STALE_AFTER_MS;
}

/** `2026-07-27 23:35 KST` for a reported floor, or `하한 없음` when the tick ran with none. Both
 *  spellings live here so the two report lines below cannot word the same fact differently. */
function reportedFloorText(floor: string | undefined): string {
  return floor === undefined ? "하한 없음" : (kstStamp(floor) ?? floor);
}

/**
 * What the card says about the scheduler's translation floor — the second half of the breakdown, and
 * the half whose reach is not universal.
 *
 * Four states because `CollectedReach` has four, and collapsing any two of them is the mistake this
 * whole area exists to prevent:
 *
 * - `measured` — a floor was read here, from systemd, and both sides of it were counted.
 * - `no-floor` — the unit runs with none. `alarming`, and worded as a condition rather than as a
 *   missing setting: it means every tick works the oldest posts in the archive first.
 * - `reported` — this screen could not ask systemd, so it is repeating what the scheduler itself
 *   wrote down. What the hosted dashboard normally shows, because a Vercel function has no systemd.
 *   The numbers are real; the claim is *as of* a moment, and `report` below is what says which
 *   moment. It must never read like `measured`.
 * - `unknown` — nothing could be read and nothing was reported. Neutral. The sentence must land as
 *   "cannot be seen from here"; a reader who takes it as "there is no floor" has been told the
 *   opposite of the truth.
 *
 * `now` is a parameter rather than a `new Date()` inside, so the age wording is assertable — a
 * staleness rule nothing can pin is a staleness rule that quietly stops firing.
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
  /**
   * The scheduler's own report, with its age — set whenever a report is part of what is being shown.
   * On `reported` that is the provenance of every number above it; on `measured`/`no-floor` it
   * appears only when the report disagrees with what systemd says here, because a disagreement is
   * information and silently preferring the fresher value is how a dead scheduler looks healthy.
   */
  report?: string;
  /** Whether that report line is itself something to act on — stale, or disagreeing with systemd. */
  reportAlarming?: boolean;
}

export function reachCopy(reach: CollectedReach, now: Date = new Date()): ReachCopy {
  switch (reach.kind) {
    case "measured":
      return {
        headline: `번역 대상 ${reach.inScope}건 · 하한 아래 ${reach.belowFloor}건`,
        detail: `하한보다 오래된 수집 항목은 스케줄러(${WATCH_UNIT})가 선택하지 않습니다.`,
        alarming: false,
        floor: reach.floor,
        ...disagreement(reach, now),
      };
    case "no-floor":
      return {
        headline: `번역 대상 ${reach.inScope}건 · 하한 없음`,
        detail:
          `${WATCH_UNIT}는 실행 중이지만 ${FLOOR_VAR}가 없습니다 — ` +
          `수집된 전부가 오래된 것부터 번역 대상입니다.`,
        alarming: true,
        ...disagreement(reach, now),
      };
    case "reported": {
      const at = reach.reportedAt ?? "";
      const stale = isStaleReport(at, now);
      const noFloor = reach.reportedFloor === undefined;
      return {
        // "(스케줄러 기록)" is the whole difference from `measured` on this line, and it is not
        // decoration: without it the two states read as one number that was checked, when only one
        // of them was.
        headline: noFloor
          ? `번역 대상 ${reach.inScope}건 · 하한 없음 (스케줄러 기록)`
          : `번역 대상 ${reach.inScope}건 · 하한 아래 ${reach.belowFloor}건 (스케줄러 기록)`,
        detail: noFloor
          ? `스케줄러가 ${FLOOR_VAR} 없이 돌았다고 기록했습니다 — ` +
            `수집된 전부가 오래된 것부터 번역 대상입니다. ` +
            `이 화면은 ${WATCH_UNIT}를 직접 읽을 수 없어 그 기록을 보여줍니다.`
          : `이 화면은 ${WATCH_UNIT}를 직접 읽을 수 없어, ` +
            `스케줄러가 마지막 tick에서 실제로 사용한 하한을 그대로 보여줍니다 — ` +
            `지금 unit 설정이 아니라 그때의 기록입니다.`,
        // A report with no floor is the same alarm `no-floor` is. A stale one is a different alarm:
        // the numbers stopped being about now.
        alarming: noFloor || stale,
        floor: reach.reportedFloor,
        report: stale
          ? `스케줄러 기록 ${kstStamp(at) ?? at} · ${reportAge(at, now)} — 그 뒤로 tick 기록이 없습니다. 스케줄러가 멈췄는지 확인하세요.`
          : `스케줄러 기록 ${kstStamp(at) ?? at} · ${reportAge(at, now)}`,
        reportAlarming: stale,
      };
    }
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

/**
 * The report line a systemd-derived state carries when the scheduler's last tick ran with a
 * different floor than the unit now sets. Empty otherwise — agreement is nothing to say.
 *
 * Two explanations, both worth looking at, so both are named: the unit was edited and no tick has
 * run since (harmless, resolves itself on the next fire), or the scheduler has stopped (not
 * harmless, and invisible from the unit's configuration alone). The age is what separates them,
 * which is why it is on the line rather than just the value.
 */
function disagreement(reach: CollectedReach, now: Date): Pick<ReachCopy, "report" | "reportAlarming"> {
  if (reach.reportedAt === undefined) return {};
  return {
    report:
      `스케줄러가 마지막으로 기록한 하한은 ${reportedFloorText(reach.reportedFloor)} ` +
      `(${reportAge(reach.reportedAt, now)}) — 지금 ${WATCH_UNIT} 설정과 다릅니다. ` +
      `unit을 고친 뒤 아직 tick이 돌지 않았거나, 스케줄러가 멈춘 것입니다.`,
    reportAlarming: true,
  };
}
