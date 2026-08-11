// tests/deploy/translateCheckTiming.test.ts
//
// The fifth member of the tests/deploy/*Timing family (watchTiming, xReconcileTiming, convertTiming,
// credsTiming), for the glossary-digest pair. Same constraint, same reason: these unit files are the
// only place the schedule exists, `tests/cli/` can run the command but cannot see whether anything
// runs it on Monday morning, and that is the half of the feature that fails silently.
//
// This one carries a shape none of its siblings do — a WEEKDAY-scoped spec (`Mon *-*-* 06:53:00`),
// which is the only way systemd expresses a seven-day cadence. A period parser that ignored the
// weekday would report 86400 for it and approve a timeout seven times too generous against the real
// gap, so the parser below reads the weekday field rather than skipping past it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const deployDir = resolve(repoRoot, "deploy");
const read = (file: string): string => readFileSync(join(deployDir, file), "utf8");
const timer = read("herald-translate-check.timer");
const service = read("herald-translate-check.service");

/**
 * Directives only. Every unit in `deploy/` quotes commands, old paths and rejected alternatives in
 * its comments to explain the incident that produced it — this one's comments name
 * `--published`, `--since` and `HERALD_OUTPUT_DIR` precisely to say it does NOT set them — and a
 * check that tripped over those would push the explanation out of the file.
 */
const directives = (unit: string): string[] =>
  unit.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

const onCalendarLines = (unit: string): string[] =>
  directives(unit).filter((l) => l.startsWith("OnCalendar="));

const onCalendar = (unit: string): string => onCalendarLines(unit)[0].slice("OnCalendar=".length).trim();

function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(directives(service).join("\n"))?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/**
 * The gap between two consecutive fires, in seconds, for the one shape this timer uses: a single
 * weekday, a fixed date wildcard, a fixed time. `undefined` for anything else.
 *
 * A single weekday and nothing else. `Mon,Thu *-*-* 06:53:00` is a three-and-four-day cycle, not a
 * week, and reporting 604800 for it would be the same silent over-approval the minute-list shape
 * produced in convertTiming.test.ts — so a list is refused here rather than averaged. Teach this
 * function the shape if a later timer needs one; do not widen the regex and leave the arithmetic.
 */
function periodSeconds(spec: string): number | undefined {
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* \d{2}:\d{2}:\d{2}$/.test(spec.trim())) return undefined;
  return 7 * 24 * 3600;
}

/**
 * Every minute a spec fires at within its hour, or `undefined` when this file cannot read the shape
 * — what the collision check below compares.
 *
 * An array, not a single minute, because `herald-convert.timer` fires twice an hour
 * (`*-*-* *:07,37:00`) and both of its minutes are minutes this unit must avoid. The obvious
 * spelling — a trailing `:(\d{2}):\d{2}$` — reads `0/2:17:00` and `0/6:41:00` correctly and silently
 * matches NOTHING in a comma list, so convert's two minutes would drop out of the check while it
 * still looked like it covered every timer in the directory. (Measured: that is exactly what the
 * first draft of this file did.)
 *
 * A second copy of `credsTiming.test.ts`'s parser rather than a shared helper, in this family's
 * style — and the two guard different pairs, so neither is redundant. That file asks "does
 * herald-creds collide with anything?"; this one asks the same for herald-translate-check, and a
 * collision between two OTHER timers is still nobody's test.
 */
function minutesOf(spec: string): string[] | undefined {
  const fields = /^(?:[A-Za-z]{3}(?:(?:\.\.|,)[A-Za-z]{3})* )?\S+ ([^\s:]+):([^\s:]+):([^\s:]+)$/.exec(spec.trim());
  if (!fields) return undefined;
  const minutes = fields[2].split(",");
  if (!minutes.every((m) => /^\d{1,2}$/.test(m))) return undefined;
  return minutes.map((m) => m.padStart(2, "0"));
}

describe("translate-check timer", () => {
  it("ships both halves of the coupling", () => {
    expect(onCalendarLines(timer)).toHaveLength(1);
    // undefined here means TimeoutStartSec= is missing or uses a unit suffix ("7min"). Either way
    // the bounds below cannot be checked, and an unbounded run is bounded by whatever
    // DefaultTimeoutStartSec this box happens to have — a decision nobody in this repo made.
    expect(timeoutStartSec()).toBeDefined();
  });

  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    // systemd accumulates OnCalendar= lines and adds OnUnitActiveSec=/OnUnitInactiveSec= as further
    // ways to set a period, so the real gap between fires can be shorter than the one line this file
    // reads. Refusing a set of directives it does not model is the same discipline `periodSeconds`
    // applies to a spec it cannot parse.
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("uses an OnCalendar shape this file can read", () => {
    // If this fails, teach `periodSeconds` the new shape. Do not delete the bounds below.
    expect(periodSeconds(onCalendar(timer))).toBeDefined();
  });

  it("fires once a week, not once a day", () => {
    // The cadence is the whole design decision, so it is pinned rather than left to a range. The
    // report has no cursor and no "seen" state — it re-reads the whole ledger and re-reports every
    // standing finding — and its inputs only move when `x:reconcile` captures a published text or a
    // human edits the glossary. Daily would re-send the same list six extra times a week, which is
    // how an ops room becomes noise people stop reading. Tightening this is a decision to make
    // deliberately, against the timer's own header, not in passing.
    expect(periodSeconds(onCalendar(timer))).toBe(604_800);
  });

  it("catches up a fire missed while the machine was off", () => {
    // A missed two-hour fire costs two hours; a missed fire here costs the week's only digest, and a
    // week with no report looks exactly like a week with nothing to report.
    expect(directives(timer)).toContainEqual("Persistent=true");
  });

  it("can actually be enabled", () => {
    // A timer with no [Install] section is one `systemctl --user enable` refuses ("has no
    // installation config") — this project's recurring failure shape read backwards: the file is
    // copied, daemon-reload succeeds, and the only thing that ever says otherwise is a line in the
    // enable command's output.
    expect(directives(timer)).toContainEqual("[Install]");
    expect(directives(timer)).toContainEqual("WantedBy=timers.target");
  });

  it("keeps the timeout at or under half the fire period", () => {
    // The sibling rule: systemd skips an OnCalendar= fire that comes due while the unit is still
    // active, so a wedged run must be killed well before the next one. Trivially satisfied at a
    // weekly cadence — asserted anyway, because it is the rule that stops the timeout being edited
    // freely if the cadence is ever tightened.
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(onCalendar(timer))! / 2);
  });

  it("leaves room for a Telegram send that hangs rather than refusing", () => {
    // The lower bound, which the check above says nothing about, and the number that actually sized
    // this unit's timeout. `notifyOps` calls global `fetch` with no timeout of its own, so an
    // unanswered send is bounded only by undici's 300s headers timeout — and reaching that is the
    // good outcome, because notifyOps swallows the failure and the run still exits 0 with its report
    // intact. A timeout at or below 300 would SIGTERM the process mid-send instead, failing the unit
    // and firing the OnFailure= hook to report a check that had in fact already finished.
    expect(timeoutStartSec()!).toBeGreaterThan(300);
  });

  it("does not share a minute with any other scheduled unit", () => {
    // Units sharing a minute buy nothing and invite two pnpm processes starting at once on a cold
    // Neon compute. Both sides derived from deploy/ rather than written out: a literal here would be
    // a second copy of the same decision, and moving this timer while updating only one of them
    // leaves the suite green with a real collision.
    const timerFiles = readdirSync(deployDir).filter((f) => f.endsWith(".timer")).sort();
    const otherSpecs = timerFiles
      .filter((f) => f !== "herald-translate-check.timer")
      .flatMap((f) => onCalendarLines(read(f)).map((l) => `${f}: ${l.slice("OnCalendar=".length).trim()}`));
    // The guard on the parser, not on the units: a spec `minutesOf` cannot read contributes no
    // minutes, and a collision check fed no minutes passes. An unreadable shape must fail here,
    // where the message says to teach the parser.
    const unreadable = otherSpecs.filter((s) => minutesOf(s.split(": ")[1]) === undefined);
    expect(unreadable, "teach minutesOf() these shapes before adding them").toEqual([]);

    const others = otherSpecs.flatMap((s) => minutesOf(s.split(": ")[1])!);
    const mine = minutesOf(onCalendar(timer));
    expect(mine, "this timer's own minute could not be read").toBeDefined();
    expect(others.length, "no other timers found — the check would pass vacuously").toBeGreaterThan(0);
    for (const minute of mine!) {
      expect(others, `herald-translate-check.timer fires at :${minute}, and so does another timer`).not.toContain(
        minute,
      );
    }
  });

  it("reads the shapes it claims to read, and refuses the ones it does not", () => {
    expect(periodSeconds("Mon *-*-* 06:53:00")).toBe(604_800);
    expect(periodSeconds("Sun *-*-* 23:01:00")).toBe(604_800);
    // The minute parser, pinned against every shape currently in deploy/ plus the weekday one this
    // timer introduced. Without this, a `minutesOf` that returned `undefined` for everything would
    // be caught by the unreadable-shape guard above but a `[]`-returning one would not.
    expect(minutesOf("Mon *-*-* 06:53:00")).toEqual(["53"]);
    expect(minutesOf("*-*-* 06:23:00")).toEqual(["23"]);
    expect(minutesOf("*-*-* 0/2:17:00")).toEqual(["17"]);
    expect(minutesOf("*-*-* *:07,37:00")).toEqual(["07", "37"]);
    for (const spec of ["hourly", "weekly", "*-*-* 0/6:41", "Mondays *-*-* 06:53:00", ""]) {
      expect(minutesOf(spec), spec).toBeUndefined();
    }
    for (const spec of [
      "Mon,Thu *-*-* 06:53:00", // two fires a week — a 3/4-day cycle, not 604800
      "Mon..Fri *-*-* 06:53:00", // a weekday RANGE, same objection
      "*-*-* 06:53:00", // daily: no weekday at all
      "*-*-* 0/6:41:00",
      "weekly",
      "",
    ]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });
});

// The lines whose *absence* is silent — the set every sibling in this family pins for its own unit,
// because nothing else in the suite would notice any of them being deleted.
describe("translate-check service — the lines whose absence fails silently", () => {
  it("runs the check with --notify, so the digest actually reaches a human", () => {
    // Without the flag every fire writes a report into a log nobody is tailing and exits 0: a
    // scheduler that looks armed and delivers nothing, the same shape herald-x-reconcile.service
    // spells `--yes` out for. Anchored on the tail of the line, where `pnpm` will actually forward
    // it — tests/deploy/runLogging.test.ts owns the other half (that the wrapper is what runs it).
    expect(service).toMatch(/^ExecStart=.*\/pnpm translate:check --notify$/m);
  });

  it("goes through the run-logging wrapper with its own unit name", () => {
    // Argument order is the wrapper's contract, not a convention: `$1` is the unit name and
    // everything after it is the command. Reversed, the wrapper names its log directory after pnpm
    // and runs the unit name as a command (measured: exit 127). This unit needs the durable log more
    // than its siblings do — the successful run's output IS the deliverable, and the journal on this
    // box holds about eight minutes of it against a seven-day cadence.
    const execStart = directives(service).find((l) => l.startsWith("ExecStart="));
    expect(execStart).toContain("%h/.herald/app/deploy/herald-run-logged.sh %n");
  });

  it("narrows nothing, because the standing whole-ledger view is what a weekly digest is", () => {
    // `--status`/`--since` answer "did last week drift?"; the question this report exists for is
    // "what has drifted?". `--published` would restrict the drift half to rows that already carry a
    // published text and skip the rest, while the override half runs unconditionally anyway — so it
    // would cost coverage and buy nothing.
    const execStart = directives(service).find((l) => l.startsWith("ExecStart="))!;
    for (const narrowing of ["--status", "--since", "--published"]) {
      expect(execStart, narrowing).not.toContain(narrowing);
    }
  });

  it("reads the production environment file, so it does not report on the development database", () => {
    // %h/.herald/prod.env is the only thing that overrides .env's local-Docker DATABASE_URL. Without
    // it the fire succeeds, exits 0, and reports cheerfully on a handful of local rows — a green
    // digest about the wrong data, visible only on the command's first line, which nobody reads on a
    // run that found nothing.
    expect(service).toMatch(/^EnvironmentFile=%h\/\.herald\/prod\.env$/m);
  });

  it("hooks its own failure notice, templated on its own unit name", () => {
    // `translate:check` never exits non-zero on a finding, so a non-zero exit here can only mean the
    // run itself broke — which makes this hook the only thing standing between a dead weekly fire
    // and seven days of silence that looks exactly like a clean week. `%n`, not a literal target: a
    // hardcoded one tails another unit's journal in this one's alert (see
    // deploy/herald-notify-failure@.service's header).
    expect(service).toMatch(/^OnFailure=herald-notify-failure@%n\.service$/m);
  });

  it("sets no variable this command never reads", () => {
    // HERALD_OUTPUT_DIR is the interesting omission, and it was checked rather than assumed: the
    // translations come from PgTranslationStore (Postgres, not output/translations/translations.json)
    // and the glossary from paths.translationConfigDir, which is REPO_ROOT-relative — so the variable
    // would not even redirect the one file this command opens. The other four bound a --limit or a
    // page count belonging to translate:prepare, convert:prepare or collect, none of which this runs.
    for (const dead of [
      "HERALD_OUTPUT_DIR",
      "HERALD_TRANSLATE_SINCE",
      "HERALD_WATCH_BATCH",
      "HERALD_CONVERT_BATCH",
      "HERALD_COLLECT_MAX_PAGES",
    ]) {
      expect(directives(service), dead).not.toContainEqual(expect.stringContaining(`Environment=${dead}=`));
    }
  });

  it("is a oneshot, so systemd knows the run has finished", () => {
    // Without Type=oneshot systemd treats the unit as started the moment the process is spawned, and
    // TimeoutStartSec= — the whole bound this file checks — stops applying to the run at all.
    expect(service).toMatch(/^Type=oneshot$/m);
  });
});
