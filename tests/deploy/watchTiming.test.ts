// tests/deploy/watchTiming.test.ts
//
// Two numbers in two files with a constraint between them, and until now the constraint lived only
// in a comment. systemd skips an OnCalendar= fire that comes due while the unit is still active, so
// a TimeoutStartSec= larger than the fire period turns one wedged tick into a scheduler that looks
// armed and has silently stopped — the single failure this whole feature exists to prevent.
//
// herald-watch.timer's own header invites the edit that tests this ("hourly is a one-line change").
// That is exactly why it is a check and not a sentence: the person making that one-line change is
// not going to re-derive the timeout arithmetic first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const timer = readFileSync(resolve(repoRoot, "deploy/herald-watch.timer"), "utf8");
const service = readFileSync(resolve(repoRoot, "deploy/herald-watch.service"), "utf8");

/** The `OnCalendar=` value, ignoring the comment block above it. */
function onCalendar(): string | undefined {
  return /^OnCalendar=(.+)$/m.exec(timer)?.[1]?.trim();
}

/** Every `OnCalendar=` line, not just the first — see the "one schedule" test for why. */
function onCalendarLines(): string[] {
  return timer.match(/^OnCalendar=.+$/gm) ?? [];
}

/**
 * `TimeoutStartSec=` as a plain count of seconds, or `undefined` if it is not written that way.
 * systemd also accepts "30min" and "1h"; supporting those here would mean a unit-suffix parser
 * whose bugs are invisible, so the one shape the unit actually uses is the one shape this reads —
 * and anything else fails the first test below rather than being silently skipped.
 */
function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(service)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/**
 * Fire period in seconds for the two OnCalendar shapes this timer plausibly uses, and `undefined`
 * for anything else:
 *   `*-*-* 0/2:17:00` → every 2 hours
 *   `*-*-* *:17:00`   → hourly
 * Deliberately narrow. A spec this cannot read means the bound below is unchecked, which is the
 * state this file exists to end — so it reports that rather than guessing.
 */
function periodSeconds(spec: string): number | undefined {
  const everyNHours = /^\*-\*-\* \d+\/(\d+):\d{2}:\d{2}$/.exec(spec);
  if (everyNHours) return Number(everyNHours[1]) * 3600;
  if (/^\*-\*-\* \*:\d{2}:\d{2}$/.test(spec)) return 3600;
  return undefined;
}

describe("watch scheduler timing", () => {
  it("ships both halves of the coupling", () => {
    expect(onCalendar()).toBeDefined();
    // undefined here means TimeoutStartSec= is missing or uses a unit suffix. Either way the bound
    // below cannot be checked, and an unbounded tick holds the unit active across the next fire.
    expect(timeoutStartSec()).toBeDefined();
  });

  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    // `onCalendar()` reads the *first* OnCalendar= line. systemd does not: it accumulates them, so
    // the real fire period is the shortest gap any of them produces, and `OnUnitActiveSec=`/
    // `OnUnitInactiveSec=` each set a period a third (and fourth) way again — the latter measured
    // from the unit's last deactivation rather than its last activation, but just as capable of
    // shortening the real period. Any of these could push the real period below the bound checked
    // further down while that check kept passing against a line that is no longer the whole
    // schedule. This file already refuses OnCalendar shapes it cannot read rather than skipping the
    // bound; the same discipline says to refuse a *set* of directives it does not model.
    expect(onCalendarLines()).toHaveLength(1);
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    // Nor may the service carry its own schedule while looking like a plain oneshot.
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("uses an OnCalendar shape this file can read", () => {
    // If this fails, teach `periodSeconds` the new shape. Do not delete the bound below.
    expect(periodSeconds(onCalendar()!)).toBeDefined();
  });

  it("keeps the tick timeout at or under half the fire period", () => {
    // Half, not all of it: this admits the hourly change the timer's header already sanctions
    // (1800 ≤ 3600/2) while rejecting anything faster, and leaves a full period of slack at the
    // two-hour cadence it ships with.
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(onCalendar()!)! / 2);
  });

  it("reads the shapes it claims to read", () => {
    // Pins the parser against real values. Without this, a `periodSeconds` that returned
    // `undefined` for everything would still satisfy the rejection test below.
    expect(periodSeconds("*-*-* 0/2:17:00")).toBe(7200);
    expect(periodSeconds("*-*-* *:17:00")).toBe(3600);
    expect(periodSeconds("*-*-* 0/6:17:00")).toBe(21600);
  });

  it("refuses shapes it cannot read instead of guessing a period", () => {
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "*-*-* 0/2:17", "*-*-* 00,30:17:00", ""]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });
});
