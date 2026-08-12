/**
 * When the two schedulers next fire, worked out in the browser.
 *
 * The header funnel draws a small countdown pie on the two stages a systemd timer feeds — 번역
 * (`herald-watch`, every two hours at :17) and 렌더 (`herald-convert`, every 30 minutes at :07 and
 * :37). Neither needs asking: an `OnCalendar=` is a fixed calendar, so where the next fire lands is
 * pure arithmetic on the current instant. That is the whole reason this file exists instead of an
 * `/api/status` field — a Vercel function has no systemd to ask either (see `CollectedBreakdownCard`
 * on the floor it cannot read), and a countdown that had to be fetched would be stale the moment it
 * arrived and would cost a request a minute to keep fresh.
 *
 * The copy of the schedule below is the cost of that, and it is a real one: nobody editing
 * `deploy/herald-watch.timer` would think to open a `.ts` file, and a stale pie keeps sweeping around
 * looking exactly as authoritative as a correct one. `tests/deploy/dashboardTickTiming.test.ts` reads
 * both timer files and fails if either constant drifts from the unit it claims to mirror.
 */

/**
 * Korea is UTC+9 all year — no DST, and none since 1988 — so a fixed offset is exact here rather
 * than an approximation of what `Intl` would say. That matters because this module needs KST as a
 * *number* (see `msSinceKstMidnight`), which a formatter cannot give it.
 */
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Floored modulo — `%` keeps the sign of the dividend, which is wrong for every wrap below. */
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Milliseconds since the most recent KST midnight — the anchor everything here counts from. */
const msSinceKstMidnight = (at: Date): number => mod(at.getTime() + KST_OFFSET_MS, DAY_MS);

/**
 * One timer's cadence, reduced to the two numbers a countdown needs: how often it fires, and the
 * offset within that period it fires at.
 *
 * `*-*-* *:07,37:00` collapses into a single pair because 37 is 7 modulo 30 — a minute list is how
 * systemd spells a sub-hourly period, not a second schedule. A spec that does *not* reduce this way
 * (uneven gaps, or a period that does not divide the day) has no honest pie, and the drift test
 * refuses it rather than picking a number.
 */
export interface TickSchedule {
  readonly periodMs: number;
  readonly phaseMs: number;
}

/** 번역 틱 — `deploy/herald-watch.timer`, `OnCalendar=*-*-* 0/2:17:00`. */
export const WATCH_TICK: TickSchedule = { periodMs: 120 * MINUTE_MS, phaseMs: 17 * MINUTE_MS };

/** 변환 틱 — `deploy/herald-convert.timer`, `OnCalendar=*-*-* *:07,37:00`. */
export const CONVERT_TICK: TickSchedule = { periodMs: 30 * MINUTE_MS, phaseMs: 7 * MINUTE_MS };

export interface TickPhase {
  /** The instant the schedule next fires. */
  readonly nextAt: Date;
  /** How long until it does. Never 0: at a fire instant this is a whole period again. */
  readonly remainingMs: number;
  /** How far through the current period we are, `[0, 1)` — the fraction of the pie that is filled. */
  readonly fraction: number;
}

/**
 * Where in its period a schedule is at `now`.
 *
 * Anchored at KST **midnight**, and this is the one decision in the file that is easy to get wrong
 * invisibly. `0/2:17` means every second hour *of the Korean day*, and 9 hours is 540 minutes, which
 * is not a multiple of 120 — so anchoring on UTC midnight puts the 번역 틱 an hour out while the pie
 * still sweeps smoothly and the tooltip still names a plausible minute. The viewer's own midnight is
 * worse again: the same board would count down differently depending on who had it open, which is
 * the defect `kstStamp` (`types.ts`) exists to prevent for timestamps. Both periods divide 1440
 * evenly, so a day is a whole number of periods and the anchor is continuous from one to the next —
 * pinned on the `deploy/` side by `tests/deploy/dashboardTickTiming.test.ts`.
 *
 * At a fire instant exactly: `fraction` is 0 and `remainingMs` is a full period. The pie has just
 * emptied, which is what "the tick ran" looks like — the alternative reading (full, and also two
 * hours away) would leave it pinned at "about to fire" for the whole period.
 */
export function tickPhase(now: Date, schedule: TickSchedule): TickPhase {
  const { periodMs, phaseMs } = schedule;
  const sinceLastFire = mod(msSinceKstMidnight(now) - phaseMs, periodMs);
  const remainingMs = periodMs - sinceLastFire;
  return {
    nextAt: new Date(now.getTime() + remainingMs),
    remainingMs,
    fraction: sinceLastFire / periodMs,
  };
}

/**
 * `14:17` — the clock face in Seoul, zero-padded, 24-hour.
 *
 * Arithmetic rather than `Intl`, deliberately, and it is the only place in this app that formats a
 * time without one. The period maths above already establishes a numeric KST anchor; going through a
 * formatter here would answer "what time is it in Seoul" a second way, and the two could then be
 * edited apart. They cannot disagree today (Korea has no DST), and
 * `tests/web/tickSchedule.test.ts` asserts this against `Intl` under four ambient zones so the day
 * that stops being true is a failing test rather than a wrong tooltip.
 */
export const kstHhMm = (at: Date): string => {
  const minutes = Math.floor(msSinceKstMidnight(at) / MINUTE_MS);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

/**
 * The pie's tooltip: `번역 틱 · 다음 실행 14:17 KST · 14분 후`.
 *
 * It says when the TICK runs. It must never say, or let a reader infer, that a particular item will
 * be handled by that run — a tick takes at most `DEFAULT_WATCH_BATCH` items and the queue drains in
 * order, so a queue longer than one batch takes several ticks. `INTAKE_OUTCOME_MESSAGE`
 * (`types.ts`) carries the same constraint and the full reasoning; this is the other place on the
 * board where the promise is one word away.
 *
 * `KST` is spelled out for the reason `kstStamp` gives: this board is shared, and read from more
 * than one country. The minutes round *up* — the pie only re-renders once a minute, so flooring
 * would show `0분 후` for up to a minute while the tick had not yet run.
 */
export const tickTooltip = (name: string, phase: TickPhase): string =>
  `${name} · 다음 실행 ${kstHhMm(phase.nextAt)} KST · ${Math.ceil(phase.remainingMs / MINUTE_MS)}분 후`;
