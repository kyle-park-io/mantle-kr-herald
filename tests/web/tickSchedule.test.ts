// tests/web/tickSchedule.test.ts
//
// The clock arithmetic behind the two countdown pies in the header funnel. Nothing here talks to a
// server: the schedulers fire on a fixed calendar, so where the next fire lands is derivable in the
// browser, and the whole feature is this file's function plus an SVG.
//
// Two things can go wrong in a way no reviewer would notice, and both are pinned below.
//
// The ANCHOR. `tickPhase` counts from KST midnight, not UTC midnight and not the viewer's own. Nine
// hours is 540 minutes, which is not a multiple of the 번역 틱's 120 — so a UTC anchor puts that
// pie's countdown a whole hour out while still ticking down convincingly. Both periods divide 1440
// evenly, which is what makes the KST-midnight anchor consistent from one day to the next; the
// `deploy/` half of that claim is pinned in `tests/deploy/dashboardTickTiming.test.ts`.
//
// The AMBIENT ZONE. Every assertion below is written against a fixed UTC instant and the whole file
// runs again under four `process.env.TZ` values, because this board is read from Korea and written
// from a laptop that is not, and a function that quietly agreed with `Asia/Seoul` only when the
// runner already was in Asia/Seoul would pass every review. `kstStamp.test.ts` makes the same point
// about the formatter it guards ("a test that cannot fail where it is written is barely a test").
import { afterAll, describe, expect, it } from "vitest";
import {
  CONVERT_TICK,
  KST_OFFSET_MS,
  WATCH_TICK,
  kstHhMm,
  tickPhase,
  tickTooltip,
  type TickSchedule,
} from "../../web/src/tickSchedule";

const MIN = 60_000;

/**
 * The zones this file runs under. Not decoration: `Asia/Seoul` proves the assertions are not merely
 * agreeing with the runner, `UTC` is what CI is, `America/New_York` is where a reviewer's laptop
 * plausibly is, and `Pacific/Kiritimati` (UTC+14) is on the *other* side of the date line from Seoul
 * — the one that catches an implementation reaching for `getHours()` on a day that has not started
 * yet in Korea.
 */
const ZONES = ["UTC", "Asia/Seoul", "America/New_York", "Pacific/Kiritimati"];

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** Runs one assertion body under every zone in `ZONES`, naming the zone when it fails. */
const inEveryZone = (body: () => void) => {
  for (const tz of ZONES) {
    process.env.TZ = tz;
    try {
      body();
    } catch (e) {
      throw new Error(`under TZ=${tz}: ${(e as Error).message}`);
    }
  }
};

/** `2026-08-12T05:17:00.000Z` from `"14:17"` KST on 2026-08-12 — the reverse of how these read. */
const atKst = (hhmm: string, day = "2026-08-12") => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + (h * 60 + m) * MIN - KST_OFFSET_MS);
};

describe("tickPhase — the 번역 틱 (herald-watch, every two hours at :17)", () => {
  it("reads as just fired at the fire instant itself, not as a full period elapsed", () => {
    // The boundary both directions of the arithmetic meet at. `fraction === 0` (an empty pie) and
    // `remainingMs === periodMs` (a whole period to wait) are the same instant described twice; the
    // alternative — a full pie that is also 120 minutes away — would render as "about to fire" for
    // the next two hours.
    inEveryZone(() => {
      const phase = tickPhase(atKst("14:17"), WATCH_TICK);
      expect(phase.fraction).toBe(0);
      expect(phase.remainingMs).toBe(120 * MIN);
      expect(phase.nextAt.toISOString()).toBe("2026-08-12T07:17:00.000Z"); // 16:17 KST
    });
  });

  it("has barely filled a minute after a fire", () => {
    inEveryZone(() => {
      const phase = tickPhase(atKst("14:18"), WATCH_TICK);
      expect(phase.fraction).toBeCloseTo(1 / 120, 10);
      expect(phase.remainingMs).toBe(119 * MIN);
    });
  });

  it("is half full at the midpoint", () => {
    inEveryZone(() => {
      const phase = tickPhase(atKst("15:17"), WATCH_TICK);
      expect(phase.fraction).toBe(0.5);
      expect(phase.remainingMs).toBe(60 * MIN);
      expect(phase.nextAt.toISOString()).toBe("2026-08-12T07:17:00.000Z");
    });
  });

  it("is all but full a minute before the next fire", () => {
    inEveryZone(() => {
      const phase = tickPhase(atKst("16:16"), WATCH_TICK);
      expect(phase.fraction).toBeCloseTo(119 / 120, 10);
      expect(phase.remainingMs).toBe(1 * MIN);
      expect(phase.nextAt.toISOString()).toBe("2026-08-12T07:17:00.000Z");
    });
  });

  it("counts down to 00:17 KST across the KST midnight it anchors on", () => {
    // 15:10 UTC is 00:10 the NEXT day in Seoul, seven minutes short of the day's first fire. This is
    // the assertion a UTC anchor fails and fails plausibly: anchored on UTC midnight the same instant
    // is 910 minutes in, 53 past a "fire", and the pie would promise 01:17 KST — an hour at which
    // this timer never runs.
    inEveryZone(() => {
      const phase = tickPhase(new Date("2026-08-11T15:10:00.000Z"), WATCH_TICK);
      expect(phase.remainingMs).toBe(7 * MIN);
      expect(phase.nextAt.toISOString()).toBe("2026-08-11T15:17:00.000Z");
      expect(kstHhMm(phase.nextAt)).toBe("00:17");
    });
  });
});

describe("tickPhase — the 변환 틱 (herald-convert, every 30 minutes at :07 and :37)", () => {
  it("reads as just fired at the fire instant itself", () => {
    inEveryZone(() => {
      const phase = tickPhase(atKst("14:07"), CONVERT_TICK);
      expect(phase.fraction).toBe(0);
      expect(phase.remainingMs).toBe(30 * MIN);
      expect(kstHhMm(phase.nextAt)).toBe("14:37");
    });
  });

  it("treats :37 as the same schedule as :07, half a period on", () => {
    // The half of `*:07,37:00` a single `{ periodMs, phaseMs }` pair has to earn: 37 is 7 modulo 30,
    // so both minutes fall out of one phase rather than needing a list.
    inEveryZone(() => {
      const phase = tickPhase(atKst("14:37"), CONVERT_TICK);
      expect(phase.fraction).toBe(0);
      expect(kstHhMm(phase.nextAt)).toBe("15:07");
    });
  });

  it("is partway through between two fires", () => {
    inEveryZone(() => {
      const phase = tickPhase(atKst("14:20"), CONVERT_TICK);
      expect(phase.fraction).toBeCloseTo(13 / 30, 10);
      expect(phase.remainingMs).toBe(17 * MIN);
      expect(kstHhMm(phase.nextAt)).toBe("14:37");
    });
  });

  it("crosses KST midnight without skipping a fire", () => {
    // 23:52 KST — the next fire is 00:07 the following Korean day, 15 minutes later.
    inEveryZone(() => {
      const phase = tickPhase(atKst("23:52"), CONVERT_TICK);
      expect(phase.remainingMs).toBe(15 * MIN);
      expect(phase.nextAt.toISOString()).toBe("2026-08-12T15:07:00.000Z");
      expect(kstHhMm(phase.nextAt)).toBe("00:07");
    });
  });
});

describe("tickPhase — the properties that hold at every minute of the day", () => {
  /** Every minute of one Korean day, as UTC instants. */
  const everyMinuteOfAKstDay = () =>
    Array.from({ length: 24 * 60 }, (_, i) => new Date(Date.parse("2026-08-12T00:00:00.000Z") - KST_OFFSET_MS + i * MIN));

  /**
   * The next fire's Korean clock face, read through `Intl` rather than through this module's own
   * `kstHhMm`. Deliberate: both halves of a sweep expressed in one module's arithmetic agree with
   * each other even when that arithmetic is wrong — measured, by setting `KST_OFFSET_MS` to 0, which
   * these assertions survived unchanged. Going out to the zone database for the readback makes the
   * sweep an independent check rather than a tautology.
   */
  const kstFaceOf = (at: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(at)
      .split(":")
      .map(Number);

  const check = (schedule: TickSchedule, minutes: number[]) => {
    for (const now of everyMinuteOfAKstDay()) {
      const phase = tickPhase(now, schedule);
      const [hh, mm] = kstFaceOf(phase.nextAt);
      // The pie is only ever right if the instant it counts to is one the unit actually fires at.
      // Sweeping the day is what turns that from "the four cases someone thought of" into a claim:
      // a wrong anchor cannot survive 1440 of these, because it is wrong at a different offset in
      // each hour.
      expect(minutes, `${now.toISOString()} → ${hh}:${mm} KST`).toContain(mm);
      expect(phase.remainingMs).toBeGreaterThan(0);
      expect(phase.remainingMs).toBeLessThanOrEqual(schedule.periodMs);
      expect(phase.fraction).toBeGreaterThanOrEqual(0);
      expect(phase.fraction).toBeLessThan(1);
      if (schedule === WATCH_TICK) expect(hh % 2, `${hh}:${mm} KST is an odd hour`).toBe(0);
    }
  };

  it("always counts the 번역 틱 down to an even hour at :17 KST", () => {
    process.env.TZ = "America/New_York";
    check(WATCH_TICK, [17]);
  });

  it("always counts the 변환 틱 down to :07 or :37 KST", () => {
    process.env.TZ = "America/New_York";
    check(CONVERT_TICK, [7, 37]);
  });
});

describe("kstHhMm", () => {
  it("agrees with Intl's Asia/Seoul, which is what the rest of the board formats with", () => {
    // This module does its own arithmetic rather than calling `Intl` — the period math already needs
    // a numeric KST anchor, and formatting the same instant a second way would make "what time is it
    // in Seoul" answerable twice. Korea has no DST, so a fixed offset cannot disagree with the zone
    // database; this test is that sentence in executable form, and would catch the day the claim
    // stopped being true.
    const intl = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    inEveryZone(() => {
      for (const iso of [
        "2026-08-12T05:17:00.000Z", // 14:17 KST, an ordinary afternoon
        "2026-08-11T15:00:00.000Z", // 00:00 KST — midnight prints 00:00, never 24:00
        "2026-08-11T14:59:00.000Z", // 23:59 KST the previous Korean day
        "2026-01-01T12:00:00.000Z", // winter, in case anybody ever adds a DST branch
      ]) {
        expect(kstHhMm(new Date(iso)), iso).toBe(intl.format(new Date(iso)));
      }
    });
  });
});

describe("tickTooltip", () => {
  it("names the tick, the KST instant it next runs at, and how long that is", () => {
    inEveryZone(() => {
      expect(tickTooltip("번역 틱", tickPhase(atKst("14:03"), WATCH_TICK))).toBe("번역 틱 · 다음 실행 14:17 KST · 14분 후");
    });
  });

  it("rounds the remaining minutes up, so a pie about to fire never reads 0분 후", () => {
    // The pie re-renders once a minute, so the last frame before a fire is up to 60 seconds of
    // "0분 후" if this floors — a countdown that has visibly stopped while the tick has not run.
    process.env.TZ = "UTC";
    const halfAMinuteToGo = new Date(atKst("14:36").getTime() + 30_000);
    expect(tickTooltip("변환 틱", tickPhase(halfAMinuteToGo, CONVERT_TICK))).toContain("1분 후");
    // And at the fire instant it is a whole period away again, not zero.
    expect(tickTooltip("변환 틱", tickPhase(atKst("14:07"), CONVERT_TICK))).toContain("30분 후");
  });

  it("says when the TICK runs, and never that a particular item is next", () => {
    // A recorded decision, not a style note. One tick takes at most `DEFAULT_WATCH_BATCH` items and
    // the queue drains in order, so a queue longer than the batch takes several ticks —
    // `INTAKE_OUTCOME_MESSAGE` (web/src/types.ts) had to be reworded for exactly this reason, from
    // "다음 번역 틱에서" to "번역 틱이 돌면". A tooltip on a countdown is the easiest place in the
    // whole dashboard to promise the same thing again by accident.
    const tip = tickTooltip("번역 틱", tickPhase(atKst("14:03"), WATCH_TICK));
    for (const forbidden of ["항목", "처리", "초안", "이 건", "다음 틱에"]) {
      expect(tip, `the tooltip must not talk about what happens to an item: ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("the two schedules themselves", () => {
  it("divide the Korean day evenly, which is what the anchor assumes", () => {
    // `tickPhase` restarts its count at every KST midnight. That is only continuous with the
    // schedule if a whole number of periods fits in a day — otherwise the last fire before midnight
    // and the first after it are a short (or long) period apart, and the pie jumps at midnight.
    // The `deploy/` side of this is pinned in `tests/deploy/dashboardTickTiming.test.ts`; this side
    // is the constant a future edit would change without opening a timer file.
    for (const [name, schedule] of [["WATCH_TICK", WATCH_TICK], ["CONVERT_TICK", CONVERT_TICK]] as const) {
      expect(24 * 60 * MIN, name).toBe(Math.round((24 * 60 * MIN) / schedule.periodMs) * schedule.periodMs);
      // A phase at or past the period would be the same schedule written confusingly, and it would
      // make `phaseMs` disagree with the minute a reader sees in the timer file.
      expect(schedule.phaseMs, name).toBeLessThan(schedule.periodMs);
    }
  });
});
