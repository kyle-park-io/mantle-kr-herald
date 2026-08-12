// tests/deploy/dashboardTickTiming.test.ts
//
// The dashboard now draws two countdown pies in its header funnel, and it draws them from a copy of
// the schedule — `WATCH_TICK` and `CONVERT_TICK` in `web/src/tickSchedule.ts`. There is no API field
// behind them and no network call: the browser cannot ask systemd anything, so the only way a page
// served from Vercel can say "the 번역 틱 runs in 14 minutes" is to hold the same calendar the unit
// file holds.
//
// That makes this the third restatement of `OnCalendar=` in the repository, after the unit headers'
// own prose and `docs/ko/schedulers.md`, and the quietest of the three. A doc that goes stale reads
// wrong to somebody who is already reading about schedulers; a pie that goes stale keeps sweeping
// around, once a minute, looking exactly as authoritative as it did the day it was right. Nobody
// editing `*-*-* 0/2:17:00` would think to open a `.tsx` file.
//
// So this pins the two in both directions, the way `tests/docs/schedulerOverview.test.ts` pins the
// overview table against `deploy/`. It sits in the `tests/deploy/*Timing` family rather than beside
// the frontend tests because this is the shelf somebody changing a cadence already has open —
// `watchTiming.test.ts` and `convertTiming.test.ts` read the very same two files, for the
// TimeoutStartSec= coupling this test says nothing about. Their `periodSeconds` helpers are private
// to their files and answer a different question (the SHORTEST gap, for a timeout bound); this one
// needs the gap *and* the offset it repeats at, and needs to refuse a schedule that has no single
// answer, so it parses the spec again rather than exporting theirs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";
import { CONVERT_TICK, WATCH_TICK, type TickSchedule } from "../../web/src/tickSchedule";

const MIN = 60_000;
const DAY_MINUTES = 24 * 60;

const timer = (unit: string) => readFileSync(join(REPO_ROOT, "deploy", `${unit}.timer`), "utf8");

/**
 * Every `OnCalendar=` line, not just the first. systemd accumulates them, so a second line is a
 * second schedule — and a pie that models one `{ periodMs, phaseMs }` pair could not draw that
 * honestly. The tests below refuse it rather than reading line one and calling it the schedule, the
 * same discipline `watchTiming.test.ts` applies to `OnUnitActiveSec=`.
 */
const onCalendarLines = (unit: string): string[] => timer(unit).match(/^OnCalendar=.+$/gm) ?? [];

const onCalendar = (unit: string): string | undefined => /^OnCalendar=(.+)$/m.exec(timer(unit))?.[1]?.trim();

/**
 * Every minute of a day this spec fires at, or `undefined` for a shape this file cannot read.
 * Handles the two shapes these two units use — `*-*-* 0/2:17:00` (an hour step) and
 * `*-*-* *:07,37:00` (a minute list) — by expanding them, rather than by pattern-matching each into
 * a period: expansion is what makes the "evenly spaced" question below answerable at all.
 *
 * Deliberately narrow, for the reason its siblings in this directory give: a spec this cannot read
 * means the comparison below is unchecked, which is the state this file exists to end, so it reports
 * that rather than guessing.
 */
function fireMinutes(spec: string): number[] | undefined {
  const m = /^\*-\*-\* (\*|\d+\/\d+):((?:\d{2})(?:,\d{2})*):00$/.exec(spec);
  if (m === null) return undefined;

  const hours: number[] = [];
  if (m[1] === "*") for (let h = 0; h < 24; h++) hours.push(h);
  else {
    const [start, step] = m[1].split("/").map(Number);
    if (start > 23 || step < 1) return undefined;
    for (let h = start; h < 24; h += step) hours.push(h);
  }

  const minutes = m[2].split(",").map(Number);
  if (minutes.some((x) => x > 59)) return undefined;

  return [...new Set(hours.flatMap((h) => minutes.map((x) => h * 60 + x)))].sort((a, b) => a - b);
}

/**
 * The spec as the dashboard models it — one period and one offset — or `undefined` when it has no
 * such form.
 *
 * The refusals are the point. `*-*-* *:05,10:00` fires twice an hour at wildly uneven gaps, and
 * `*-*-* 0/7:17:00` fires seven hours apart until it doesn't (17:17 to 00:17 is three). Either would
 * still produce a pie, sweeping smoothly and arriving at the wrong minute; there is no honest
 * `{ periodMs, phaseMs }` for them, so this returns nothing and the tests below fail loudly instead.
 */
function dashboardSchedule(spec: string): TickSchedule | undefined {
  const fires = fireMinutes(spec);
  if (fires === undefined || fires.length === 0) return undefined;

  // The gap *into* each fire, the first one measured across midnight — which is the gap a parser
  // that only subtracted consecutive entries would never look at, and the one that decides whether
  // the KST-midnight anchor is continuous.
  const gaps = fires.map((f, i) => (i === 0 ? f + DAY_MINUTES - fires[fires.length - 1] : f - fires[i - 1]));
  const period = gaps[0];
  if (gaps.some((g) => g !== period)) return undefined;
  // Implied by the above for a spec built out of whole hours and minutes, asserted anyway because
  // `tickPhase` restarts its count at KST midnight and is only correct if a whole number of periods
  // fits in the day.
  if (DAY_MINUTES % period !== 0) return undefined;

  return { periodMs: period * MIN, phaseMs: (fires[0] % period) * MIN };
}

describe("the header funnel's countdown pies against deploy/", () => {
  it("gives the 번역 틱 pie herald-watch.timer's own schedule", () => {
    // If this fails, one of the two moved. The timer file is the record of truth — `WATCH_TICK`
    // follows it, never the other way around.
    expect(dashboardSchedule(onCalendar("herald-watch")!)).toEqual(WATCH_TICK);
  });

  it("gives the 변환 틱 pie herald-convert.timer's own schedule", () => {
    // The 변환 틱 is the one whose cadence has a stated price — `convertTiming.test.ts` explains why
    // 30 minutes is a billing decision — so this is also the pie most likely to be looking at a
    // number somebody deliberately changed.
    expect(dashboardSchedule(onCalendar("herald-convert")!)).toEqual(CONVERT_TICK);
  });

  it("reads a single OnCalendar= from each of the two units it draws", () => {
    // A pie is one period and one offset. Two OnCalendar= lines are two schedules, and the check
    // above would keep comparing against the first of them while the unit fired on both.
    expect(onCalendarLines("herald-watch")).toHaveLength(1);
    expect(onCalendarLines("herald-convert")).toHaveLength(1);
    for (const unit of ["herald-watch", "herald-convert"]) {
      expect(timer(unit), unit).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    }
  });

  it("reads the shapes it claims to read", () => {
    // Pins the parser against real values. Without this, a `dashboardSchedule` that returned
    // `undefined` for everything would still satisfy the rejection test below — and the two
    // comparisons above would fail rather than pass, but for a reason nobody could read off them.
    expect(dashboardSchedule("*-*-* 0/2:17:00")).toEqual({ periodMs: 120 * MIN, phaseMs: 17 * MIN });
    expect(dashboardSchedule("*-*-* *:07,37:00")).toEqual({ periodMs: 30 * MIN, phaseMs: 7 * MIN });
    expect(dashboardSchedule("*-*-* *:17:00")).toEqual({ periodMs: 60 * MIN, phaseMs: 17 * MIN });
    expect(dashboardSchedule("*-*-* *:00,15,30,45:00")).toEqual({ periodMs: 15 * MIN, phaseMs: 0 });
    // The minute list whose phase is not its first entry taken literally: 37 is 7 modulo 30, which is
    // exactly the fact that lets one pair of numbers describe `*:07,37:00`.
    expect(dashboardSchedule("*-*-* *:07,37:00")!.phaseMs).toBe(7 * MIN);
  });

  it("refuses a schedule it cannot draw as one sweep, instead of drawing a wrong one", () => {
    for (const spec of [
      "Mon *-*-* 17:00:00", // a weekday restriction — not every day looks the same
      "hourly", // a shorthand, not a calendar this parses
      "*-*-* *:05,10:00", // two fires an hour, 5 and 55 minutes apart
      "*-*-* 0/7:17:00", // seven hours, except across midnight, where it is three
      "*-*-* *:7,37:00", // one-digit minute
      "*-*-* *:07,37", // no seconds field
      "*-*-* *:07,37:30", // fires at :30 past the minute — this file models whole minutes
      "",
    ]) {
      expect(dashboardSchedule(spec), spec).toBeUndefined();
    }
  });
});
