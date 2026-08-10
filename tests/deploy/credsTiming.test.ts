// tests/deploy/credsTiming.test.ts
//
// The creds unit and timer as text — the convention the rest of tests/deploy/ uses, and the only
// place these properties are visible at all. `tests/cli/credsCheck.test.ts` runs the command; it
// cannot see the file that decides whether anything runs it at 06:23, which is the half of this
// feature that fails silently.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const deployDir = resolve(repoRoot, "deploy");
const read = (file: string): string => readFileSync(join(deployDir, file), "utf8");
const service = read("herald-creds.service");
const timer = read("herald-creds.timer");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Directives only. Every unit in `deploy/` quotes old paths and commands in its comments to explain
 * the incident that produced it, and a check that tripped over those would push the explanation out
 * of the file — `tests/deploy/unitToolPaths.test.ts` makes the same split for the same reason.
 */
const directives = (unit: string): string[] =>
  unit.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

const onCalendarSpecs = (unit: string): string[] =>
  directives(unit)
    .filter((l) => l.startsWith("OnCalendar="))
    .map((l) => l.slice("OnCalendar=".length).trim());

/**
 * The minute field of an `OnCalendar=` spec, or `undefined` when this file cannot read the shape.
 *
 * An array, not a single minute, because `herald-convert.timer` fires twice an hour
 * (`*-*-* *:07,37:00`) and both of its minutes are minutes this unit must avoid. Reading only a
 * trailing `\d{2}:\d{2}$` — the obvious spelling — matches `0/2:17:00` and `0/6:41:00` and silently
 * matches *nothing* in a comma list, so convert's two minutes would drop out of the collision check
 * while the check still looked like it covered every timer in the directory.
 *
 * `undefined` rather than `[]` for an unreadable spec, so a shape this parser does not know (a
 * weekday prefix, say) fails the guard below instead of quietly contributing no minutes. An empty
 * report reading as a clean pass is the exact failure `checkLiveness` was hardened against.
 */
function minutesOf(spec: string): string[] | undefined {
  const fields = /^\S+ ([^\s:]+):([^\s:]+):([^\s:]+)$/.exec(spec.trim());
  if (!fields) return undefined;
  const minutes = fields[2].split(",");
  if (!minutes.every((m) => /^\d{1,2}$/.test(m))) return undefined;
  return minutes.map((m) => m.padStart(2, "0"));
}

/** The pnpm script an `ExecStart=` names — `x:reconcile` out of `…/pnpm x:reconcile --yes`. */
const pnpmScriptOf = (execStart: string): string | undefined =>
  /\bpnpm\s+([a-z][a-z0-9:_-]*)/.exec(execStart)?.[1];

const timerFiles = readdirSync(deployDir).filter((f) => f.endsWith(".timer")).sort();
const serviceFiles = readdirSync(deployDir).filter((f) => f.endsWith(".service")).sort();

describe("herald-creds.service", () => {
  it("runs from the deploy checkout, through the wrapper, with its own unit name", () => {
    // Argument order is not a convention, it is the wrapper's contract: `$1` is the unit name and
    // everything after it is the command, run verbatim. Getting it backwards does not fail loudly at
    // install time — it runs `pnpm` as the log directory name and the unit name as a command.
    // Verified by executing deploy/herald-run-logged.sh directly; tests/deploy/runLogging.test.ts
    // owns that half.
    const execStart = directives(service).find((l) => l.startsWith("ExecStart="));
    expect(execStart).toContain("%h/.herald/app/deploy/herald-run-logged.sh %n");
    expect(execStart).toContain("%h/.herald/bin/pnpm creds:check");
  });

  it("alerts on failure through the shared hook", () => {
    // Without this the check runs, finds a dead credential, exits 1, and nobody hears about it —
    // which is the whole point of scheduling it. `%n`, not a literal unit name: the hook is a
    // template shared with the other three units, and a hardcoded target would tail another unit's
    // journal in this one's alert (see deploy/herald-notify-failure@.service's header).
    expect(directives(service)).toContainEqual("OnFailure=herald-notify-failure@%n.service");
  });

  it("names no database, because this command opens none", () => {
    // The other three units read %h/.herald/prod.env for DATABASE_URL. Naming it here would imply a
    // dependency that does not exist — the same argument herald-x-reconcile.service makes about not
    // setting HERALD_OUTPUT_DIR for a command that touches no output tree.
    expect(directives(service).filter((l) => l.startsWith("EnvironmentFile="))).toEqual([]);
  });

  it("bounds its own run rather than inheriting a default nobody chose", () => {
    // Plain seconds, so this file can compare it. The daily cadence leaves enormous slack — the
    // sibling rule (timeout at or under half the fire period, tests/deploy/xReconcileTiming.test.ts)
    // is satisfied by any sane value here — so what this actually pins is that the directive exists
    // and is a number: without it a wedged run is bounded by systemd's DefaultTimeoutStartSec,
    // whatever the box happens to have, which is a decision nobody in this repo made.
    const raw = /^TimeoutStartSec=(\d+)$/m.exec(directives(service).join("\n"))?.[1];
    expect(raw, "no plain-seconds TimeoutStartSec=").toBeDefined();
    expect(Number(raw)).toBeGreaterThan(0);
    expect(Number(raw)).toBeLessThanOrEqual(86_400 / 2);
  });
});

describe("herald-creds.timer", () => {
  it("fires once a day", () => {
    expect(onCalendarSpecs(timer)).toEqual(["*-*-* 06:23:00"]);
  });

  it("catches up a fire missed while the machine was off", () => {
    expect(directives(timer)).toContainEqual("Persistent=true");
  });

  it("can actually be enabled", () => {
    // A timer with no [Install] section is a timer `systemctl --user enable` refuses ("has no
    // installation config"), which is this project's recurring failure shape read backwards: the
    // file is copied, daemon-reload succeeds, and the only thing that ever says otherwise is a line
    // in the enable command's output. The three timers already in deploy/ all carry it.
    expect(directives(timer)).toContainEqual("[Install]");
    expect(directives(timer)).toContainEqual("WantedBy=timers.target");
  });

  it("does not share a minute with any other scheduled unit", () => {
    // Units sharing a minute buy nothing and invite two pnpm processes starting at once on a cold
    // store — herald-x-reconcile.timer's own header makes this argument. Derived from the directory
    // so a timer added later is included without editing a list here.
    const others = timerFiles
      .filter((f) => f !== "herald-creds.timer")
      .flatMap((f) => onCalendarSpecs(read(f)).flatMap((spec) => minutesOf(spec) ?? []));
    expect(others.length, "no other timers found — the check would pass vacuously").toBeGreaterThan(0);
    expect(minutesOf(onCalendarSpecs(timer)[0])).toEqual(["23"]);
    expect(others).not.toContain("23");
  });

  it("reads every OnCalendar= in deploy/, so the check above cannot pass by understanding none", () => {
    // The guard on the parser rather than on the units. A spec `minutesOf` cannot read contributes
    // no minutes, and a collision check fed no minutes passes — so an unreadable shape must fail
    // here, where the message says to teach the parser, instead of there, where it says nothing.
    const unreadable = timerFiles.flatMap((f) =>
      onCalendarSpecs(read(f))
        .filter((spec) => minutesOf(spec) === undefined)
        .map((spec) => `${f}: OnCalendar=${spec}`),
    );
    expect(unreadable, "teach minutesOf() these shapes before adding them").toEqual([]);
    expect(timerFiles.length).toBeGreaterThan(1);
  });

  it("reads the shapes it claims to read, and refuses the ones it does not", () => {
    expect(minutesOf("*-*-* 06:23:00")).toEqual(["23"]);
    expect(minutesOf("*-*-* 0/2:17:00")).toEqual(["17"]);
    expect(minutesOf("*-*-* *:07,37:00")).toEqual(["07", "37"]);
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "daily", "*-*-* 0/6:41", ""]) {
      expect(minutesOf(spec), spec).toBeUndefined();
    }
  });
});

/**
 * The one coupling neither suite could see on its own. `tests/cli/credsCheck.test.ts` pins
 * `package.json`'s `creds:check` script to an exact string but never runs it; this unit's
 * `ExecStart=` names `pnpm creds:check` and nothing checked the name existed. Renaming the script
 * left both suites green and the timer pointing at a script `pnpm` would refuse with
 * `ERR_PNPM_NO_SCRIPT` — once a day, at 06:23, as a Telegram alert about credentials.
 *
 * Derived from `deploy/` rather than written out, because the same hole is open for `pnpm watch`,
 * `pnpm convert:tick` and `pnpm x:reconcile`, and because a unit added later is written by copying
 * one of these.
 */
describe("every scheduled unit runs a pnpm script that exists", () => {
  it("finds the units to check — an empty list would pass every case below", () => {
    expect(serviceFiles).toContain("herald-creds.service");
    expect(serviceFiles.length).toBeGreaterThan(1);
  });

  for (const file of serviceFiles) {
    const execStart = directives(read(file)).find((l) => l.startsWith("ExecStart="));
    const script = execStart === undefined ? undefined : pnpmScriptOf(execStart);

    it(`${file} → ${script === undefined ? "runs no pnpm script" : `pnpm ${script}`}`, () => {
      if (script === undefined) {
        // e.g. herald-notify-failure@.service, which runs a shell script. Asserted rather than
        // skipped: a unit that names pnpm in a spelling this file cannot read must fail here, not
        // fall through as "nothing to check".
        expect(execStart ?? "", "names pnpm but the script could not be read out of it").not.toMatch(/\bpnpm\b/);
        return;
      }
      expect(
        Object.keys(pkg.scripts),
        `deploy/${file} runs \`pnpm ${script}\`, which package.json does not define`,
      ).toContain(script);
    });
  }
});
