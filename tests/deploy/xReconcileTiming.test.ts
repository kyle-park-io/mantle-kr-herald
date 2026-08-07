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

// Three lines whose *absence* is silent. Nothing in this file used to assert any of them, so all
// three were deletable by an edit that still passed the whole suite — the same argument
// tests/deploy/watchCutoff.test.ts makes for the two cutoffs, and the same argument this branch's
// own "test the guards that were deletable" commit makes for the watch tick.
describe("x-reconcile service — the lines whose absence fails silently", () => {
  it("passes --yes, so a scheduled run actually writes", () => {
    // The unit's own comment calls the alternative "armed but silently stopped": without --yes every
    // fire prints a preview to a journal nobody is tailing, writes nothing, and exits 0. There is no
    // failing unit and no alert — the exact shape this whole timer exists to avoid.
    //
    // Anchored on the tail of the line rather than on the whole of it: since the durable-run-log
    // change the command is invoked through deploy/herald-run-logged.sh, so `ExecStart=` now starts
    // with the wrapper and its `%n` argument. What this test is about is unchanged — the flag must
    // be there, and it must be the last thing on the line, where `pnpm` will actually forward it.
    // tests/deploy/runLogging.test.ts owns the other half (that the wrapper is what runs it, from
    // the deploy checkout); duplicating that here would just be two places to update.
    expect(service).toMatch(/^ExecStart=.*\/pnpm x:reconcile --yes$/m);
  });

  it("reads the production environment file, so it does not write to the development database", () => {
    // %h/.herald/prod.env is the only thing that overrides .env's local-Docker DATABASE_URL. Without
    // it the scheduled run succeeds, exits 0, and writes irreversible `sent` rows and shared-workbook
    // history rows into the wrong database — visible only on the CLI's first line, which nobody reads
    // on a green run.
    expect(service).toMatch(/^EnvironmentFile=%h\/\.herald\/prod\.env$/m);
  });

  it("hooks its own failure notice, templated on its own unit name", () => {
    // Without OnFailure= a failing run is silent. With the OLD non-templated target it would name and
    // tail herald-watch.service's journal instead of this unit's — the incident that forced the hook
    // to become a template (see deploy/herald-notify-failure@.service's header), so %n is asserted,
    // not merely the presence of some OnFailure=.
    expect(service).toMatch(/^OnFailure=herald-notify-failure@%n\.service$/m);
  });
});
