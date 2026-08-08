// tests/deploy/convertTiming.test.ts
//
// The third member of the tests/deploy/*Timing family (watchTiming.test.ts, xReconcileTiming.test.ts),
// for the conversion pair. Same constraint, same reason: systemd skips an OnCalendar= fire that comes
// due while the unit is still active, so a TimeoutStartSec= larger than the fire period turns one
// wedged tick into a scheduler that looks armed and has silently stopped.
//
// This one carries an extra shape its siblings do not — a minute LIST (`*:07,37:00`), which is how a
// 30-minute cadence is written at all. A period parser that read only the first minute would report
// 3600 for it and quietly approve a timeout twice as long as the real gap between fires, so the
// parser below computes the shortest gap across the whole cycle rather than trusting one field.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const timer = readFileSync(resolve(repoRoot, "deploy/herald-convert.timer"), "utf8");
const service = readFileSync(resolve(repoRoot, "deploy/herald-convert.service"), "utf8");
const watchTimer = readFileSync(resolve(repoRoot, "deploy/herald-watch.timer"), "utf8");
const watchService = readFileSync(resolve(repoRoot, "deploy/herald-watch.service"), "utf8");
const reconcileTimer = readFileSync(resolve(repoRoot, "deploy/herald-x-reconcile.timer"), "utf8");

function onCalendarLines(text: string): string[] {
  return text.match(/^OnCalendar=.+$/gm) ?? [];
}

function onCalendar(text: string): string | undefined {
  return /^OnCalendar=(.+)$/m.exec(text)?.[1]?.trim();
}

/**
 * `TimeoutStartSec=` as a plain count of seconds, or `undefined` if it is not written that way.
 * systemd also accepts "15min"; supporting that here would mean a unit-suffix parser whose bugs are
 * invisible, so — exactly as watchTiming.test.ts does — the one shape the unit actually uses is the
 * one shape this reads, and anything else fails the first test below rather than being skipped.
 */
function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(service)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/** Every minute this spec fires at within one hour, or `undefined` if it is not a plain list. */
function minutesOf(spec: string): number[] | undefined {
  const field = /^\*-\*-\* (?:\*|\d+\/\d+):((?:\d{2})(?:,\d{2})*):\d{2}$/.exec(spec)?.[1];
  if (field === undefined) return undefined;
  const minutes = field.split(",").map(Number);
  if (minutes.some((m) => m > 59)) return undefined;
  // Sorted and de-duplicated, so `*:37,07:00` and `*:07,07:00` cannot produce a bogus gap of 0.
  return [...new Set(minutes)].sort((a, b) => a - b);
}

/**
 * The SHORTEST gap between two consecutive fires, in seconds — which is the number the timeout has
 * to fit inside, not the nominal "every N hours" the spec appears to say. Handles the three shapes
 * this repo's timers use:
 *   `*-*-* 0/2:17:00`  → every 2 hours              → 7200
 *   `*-*-* *:17:00`    → hourly                     → 3600
 *   `*-*-* *:07,37:00` → twice an hour, 30 min apart → 1800
 * `undefined` for anything else: a spec this cannot read means the bound below is unchecked, which
 * is the state this file exists to end, so it reports that rather than guessing.
 */
function periodSeconds(spec: string): number | undefined {
  const minutes = minutesOf(spec);
  if (minutes === undefined) return undefined;
  const everyNHours = /^\*-\*-\* \d+\/(\d+):/.exec(spec);
  const cycleMinutes = everyNHours ? Number(everyNHours[1]) * 60 : 60;
  if (cycleMinutes <= 0) return undefined;
  if (minutes.length === 1) return cycleMinutes * 60;
  const gaps = minutes.map((m, i) => (i === 0 ? minutes[0] + cycleMinutes - minutes[minutes.length - 1] : m - minutes[i - 1]));
  return Math.min(...gaps) * 60;
}

describe("convert scheduler timing", () => {
  it("ships both halves of the coupling", () => {
    expect(onCalendar(timer)).toBeDefined();
    // undefined here means TimeoutStartSec= is missing or uses a unit suffix. Either way the bound
    // below cannot be checked, and an unbounded tick holds the unit active across the next fire.
    expect(timeoutStartSec()).toBeDefined();
  });

  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    // systemd accumulates OnCalendar= lines and adds OnUnitActiveSec=/OnUnitInactiveSec= as further
    // ways to set a period, so the real gap between fires can be shorter than the one line this file
    // reads. Refusing a set of directives it does not model is the same discipline `periodSeconds`
    // applies to a spec it cannot parse.
    expect(onCalendarLines(timer)).toHaveLength(1);
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("uses an OnCalendar shape this file can read", () => {
    // If this fails, teach `periodSeconds` the new shape. Do not delete the bound below.
    expect(periodSeconds(onCalendar(timer)!)).toBeDefined();
  });

  it("fires every 30 minutes, which is the cadence the Neon budget was sized for", () => {
    // Not a style preference. The database is Neon `free_v3`: 100 CU-hours a month at 0.25 CU is 400
    // wall-clock hours of compute, and with a ~5-minute autosuspend a 30-minute poll runs the compute
    // roughly 17% of the time — about 30 CU-hours, 30% of the budget. A 10-minute poll is ~91% of it
    // and a 5-minute poll does not fit at all. Halving this interval is therefore a billing decision,
    // not a tuning one, and it should fail a test rather than pass a review.
    expect(periodSeconds(onCalendar(timer)!)).toBe(1800);
  });

  it("runs 24 hours a day rather than windowing to business hours", () => {
    // Measured human activity on this pipeline spans 10:00–04:00 KST. A window would save six hours
    // a day of polling and miss real work in the other eighteen, so the spec must stay unrestricted:
    // no weekday prefix, no hour list.
    const spec = onCalendar(timer)!;
    expect(spec.startsWith("*-*-* *:")).toBe(true);
  });

  it("keeps the tick timeout at or under half the fire period", () => {
    // Half, not all of it: a wedged tick then finishes (or is killed) well before the next fire comes
    // due, so no fire is ever skipped.
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(onCalendar(timer)!)! / 2);
  });

  it("leaves room for the one claude -p call the tick can make", () => {
    // The lower bound, which the check above says nothing about. `ClaudeCodeAgent` caps a single
    // `claude -p` at 600s and this tick makes at most one of them, so a timeout at or below that
    // would kill a perfectly healthy conversion pass — and, because the kill is a non-zero exit, fire
    // the Telegram hook every time the agent took its time.
    expect(timeoutStartSec()!).toBeGreaterThan(600);
  });

  it("reads the shapes it claims to read", () => {
    // Pins the parser against real values. Without this, a `periodSeconds` that returned `undefined`
    // for everything would still satisfy the rejection test below.
    expect(periodSeconds("*-*-* *:07,37:00")).toBe(1800);
    expect(periodSeconds("*-*-* *:00,15,30,45:00")).toBe(900);
    expect(periodSeconds("*-*-* *:17:00")).toBe(3600);
    expect(periodSeconds("*-*-* 0/2:17:00")).toBe(7200);
    // The wrap-around gap, which is the one a naive "difference between consecutive entries" parser
    // gets wrong: these two fires are 10 minutes apart across the hour boundary, not 50.
    expect(periodSeconds("*-*-* *:05,55:00")).toBe(600);
  });

  it("refuses shapes it cannot read instead of guessing a period", () => {
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "*-*-* *:07,37", "*-*-* *:7,37:00", "*-*-* *:99:00", ""]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });

  it("does not fire in the same minute as either scheduler already installed", () => {
    // All three units run `pnpm` from the same deploy checkout against the same database, and two of
    // them spawn `claude -p`. Sharing a minute buys nothing and only invites two ticks starting at
    // once on a cold Neon compute.
    const mine = new Set(minutesOf(onCalendar(timer)!)!);
    for (const [name, other] of [["herald-watch", watchTimer], ["herald-x-reconcile", reconcileTimer]] as const) {
      for (const minute of minutesOf(onCalendar(other)!)!) {
        expect(mine.has(minute), `${name} also fires at :${minute}`).toBe(false);
      }
    }
  });
});

// The lines whose *absence* is silent — the same set xReconcileTiming.test.ts pins for its own unit,
// because nothing else in the suite would notice any of them being deleted.
describe("convert scheduler service — the lines whose absence fails silently", () => {
  it("runs the conversion tick, and nothing that sends", () => {
    // The tick stops at `rendered` by design: 2차 검수 is what decides whether a variant is ever
    // sent. An ExecStart= that grew a `&& pnpm send:channels` (or drive:publish) would turn an
    // unattended scheduler into a publisher, so the command is pinned to its tail.
    //
    // `format` stays on this list even though the tick itself now runs that stage, and for a reason
    // stronger than tidiness: inside the tick it is `pnpm format --only-missing`, which cannot touch
    // an existing rendering. A `&& pnpm format` chained here would be the unflagged one — every
    // rendering in the database rebuilt from its variant, every 2차 검수 edit and approval discarded,
    // 48 times a day.
    expect(service).toMatch(/^ExecStart=.*\/pnpm convert:tick$/m);
    for (const forbidden of ["send:", "drive:publish", "format", "--approve"]) {
      expect(service.match(/^ExecStart=.*$/m)![0], forbidden).not.toContain(forbidden);
    }
  });

  it("reads the production environment file, so it does not write to the development database", () => {
    // %h/.herald/prod.env is the only thing that overrides .env's local-Docker DATABASE_URL. Without
    // it the scheduled tick succeeds, exits 0, and writes its variants into the wrong database —
    // visible only on the CLI's first line, which nobody reads on a green run.
    expect(service).toMatch(/^EnvironmentFile=%h\/\.herald\/prod\.env$/m);
  });

  it("hooks its own failure notice, templated on its own unit name", () => {
    // Without OnFailure= a failing tick is silent. `%n` is asserted rather than merely the presence
    // of some OnFailure=: a non-templated target names and tails herald-watch.service's journal
    // instead of this unit's, which is the incident that forced the hook to become a template.
    expect(service).toMatch(/^OnFailure=herald-notify-failure@%n\.service$/m);
  });

  it("shares the scheduler's own output tree with herald-watch, character for character", () => {
    // `convert:prepare` writes output/variants/pending.json, and `convert:save` reads it back to find
    // each variant's sourceKorean. That file is one file per output root, so a scheduler pointed at
    // the repo's own output/ would have its batch archived out from under it by any hand-run
    // `pnpm convert:prepare` in the development tree — the same single-file hazard
    // herald-watch.service's own HERALD_OUTPUT_DIR comment documents for the collect watermark.
    // Pinned equal to herald-watch's value rather than to a literal: two units, one decision.
    const mine = /^Environment=HERALD_OUTPUT_DIR=(.+)$/m.exec(service)?.[1];
    const watch = /^Environment=HERALD_OUTPUT_DIR=(.+)$/m.exec(watchService)?.[1];
    expect(mine).toBeDefined();
    expect(mine).toBe(watch);
  });

  it("sets no variable this command never reads", () => {
    // HERALD_TRANSLATE_SINCE and HERALD_WATCH_BATCH bound `translate:prepare`/`translate:align`,
    // neither of which this tick runs; HERALD_COLLECT_MAX_PAGES bounds `collect`, which it also never
    // runs. Setting any of them here would be dead configuration implying a code path this unit does
    // not have — and the next person reading it would reasonably believe the tick honours it.
    for (const dead of ["HERALD_TRANSLATE_SINCE", "HERALD_WATCH_BATCH", "HERALD_COLLECT_MAX_PAGES"]) {
      expect(service, dead).not.toContain(`Environment=${dead}=`);
    }
  });

  it("is a oneshot, so systemd knows the tick has finished", () => {
    // Without Type=oneshot systemd treats the unit as started the moment the process is spawned, and
    // TimeoutStartSec= — the whole bound this file checks — stops applying to the run at all.
    expect(service).toMatch(/^Type=oneshot$/m);
  });
});
