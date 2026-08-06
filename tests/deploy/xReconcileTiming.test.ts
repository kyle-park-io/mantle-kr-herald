// tests/deploy/xReconcileTiming.test.ts
//
// The sibling of tests/deploy/watchTiming.test.ts, for the reconcile pair. Same constraint, same
// reason: systemd skips an OnCalendar= fire that comes due while the unit is still active, so a
// TimeoutStartSec= larger than the fire period turns one wedged run into a timer that looks armed
// and has silently stopped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const timer = readFileSync(resolve(repoRoot, "deploy/herald-x-reconcile.timer"), "utf8");
const service = readFileSync(resolve(repoRoot, "deploy/herald-x-reconcile.service"), "utf8");
const watchTimer = readFileSync(resolve(repoRoot, "deploy/herald-watch.timer"), "utf8");

function onCalendarLines(text: string): string[] {
  return text.split("\n").filter((l) => l.startsWith("OnCalendar="));
}

function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(service)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/** Period in seconds for the two shapes these timers use; `undefined` for anything else. */
function periodSeconds(spec: string): number | undefined {
  const everyNHours = /^\*-\*-\* \d+\/(\d+):\d{2}:\d{2}$/.exec(spec);
  if (everyNHours) return Number(everyNHours[1]) * 3600;
  if (/^\*-\*-\* \*:\d{2}:\d{2}$/.test(spec)) return 3600;
  return undefined;
}

function minuteOf(spec: string): string | undefined {
  return /:(\d{2}):\d{2}$/.exec(spec)?.[1];
}

describe("x-reconcile timer", () => {
  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    expect(onCalendarLines(timer)).toHaveLength(1);
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("uses a shape this file can read, and sets the timeout as plain seconds", () => {
    const spec = onCalendarLines(timer)[0].slice("OnCalendar=".length).trim();
    expect(periodSeconds(spec)).toBeDefined();
    expect(timeoutStartSec()).toBeDefined();
  });

  it("keeps the timeout at or under half the fire period", () => {
    const spec = onCalendarLines(timer)[0].slice("OnCalendar=".length).trim();
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(spec)! / 2);
  });

  it("does not fire in the same minute as herald-watch", () => {
    // Both units run `pnpm` from the same working tree against the same database. Sharing a minute
    // buys nothing and invites two pnpm processes installing at once on a cold store.
    const mine = minuteOf(onCalendarLines(timer)[0]);
    const watch = minuteOf(onCalendarLines(watchTimer)[0]);
    expect(mine).toBeDefined();
    expect(mine).not.toBe(watch);
  });

  it("refuses shapes it cannot read instead of guessing a period", () => {
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "*-*-* 0/6:41", ""]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });

  it("reads the shapes it claims to read", () => {
    expect(periodSeconds("*-*-* 0/6:41:00")).toBe(21600);
    expect(periodSeconds("*-*-* *:41:00")).toBe(3600);
  });
});
