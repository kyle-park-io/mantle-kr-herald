// tests/deploy/backupTiming.test.ts
//
// The sixth member of the tests/deploy/*Timing family (watchTiming, xReconcileTiming, convertTiming,
// credsTiming, translateCheckTiming), for the daily backup pair. Same constraint, same reason: these
// two files are the only place the schedule exists at all, `tests/cli/` and `tests/app/` can run
// `config:push` and `state:push` but cannot see whether anything runs them at 05:47, and that is the
// half of the feature that fails silently.
//
// This unit needs the check more than its siblings do, because the bug it was built to fix is a
// SILENT SUCCESS. `EnvironmentFile=%h/.herald/prod.env` is the one line that decides which database
// `state:push` opens — a shell-exported variable beats Node's `--env-file`, so the DSN follows the
// environment file and not the tree the command runs from. Delete that line and the unit still
// fires, still exits 0, still uploads a snapshot, and still prints a cheerful row count — of the
// DEVELOPMENT database, which is the exact bug this branch exists to fix (measured 2026-08-13:
// production held 30 few-shot rows that had never been in any snapshot, against 23 locally). The
// unit's own header says as much; until this file existed, nothing failed if it were removed.
//
// The second `ExecStart=` needs it too. `credsTiming.test.ts` and `unitToolPaths.test.ts` both read
// only the FIRST `ExecStart=` of each service, so on a two-command oneshot everything about the
// second line — the script it names, the pnpm path it reaches through, the wrapper it goes via — was
// unchecked. `state:push` is the second line here, and it is the whole point of the unit.
//
// `WorkingDirectory=` is deliberately not re-asserted: tests/deploy/workingDirectory.test.ts derives
// every scheduled unit from deploy/ and already owns it, this one included.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const deployDir = resolve(repoRoot, "deploy");
const read = (file: string): string => readFileSync(join(deployDir, file), "utf8");
const service = read("herald-backup.service");
const timer = read("herald-backup.timer");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/**
 * Directives only. Every unit in `deploy/` quotes commands, measurements and rejected alternatives
 * in its comments to explain the incident that produced it — this one's header quotes a `tsx`
 * invocation and a `HERALD_PROBE` value — and a check that tripped over those would push the
 * explanation out of the file. `credsTiming.test.ts` and `unitToolPaths.test.ts` make the same split
 * for the same reason.
 */
const directives = (unit: string): string[] =>
  unit.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

const onCalendarSpecs = (unit: string): string[] =>
  directives(unit)
    .filter((l) => l.startsWith("OnCalendar="))
    .map((l) => l.slice("OnCalendar=".length).trim());

/** Every `ExecStart=`, in the order systemd runs them for a `Type=oneshot`. */
const execStarts = (unit: string): string[] => directives(unit).filter((l) => l.startsWith("ExecStart="));

/** The pnpm script an `ExecStart=` names — `state:push` out of `…/pnpm state:push`. */
const pnpmScriptOf = (execStart: string): string | undefined =>
  /\bpnpm\s+([a-z][a-z0-9:_-]*)/.exec(execStart)?.[1];

/**
 * Every minute a spec fires at within its hour, or `undefined` when this file cannot read the shape
 * — what the collision check below compares.
 *
 * A third copy of `credsTiming.test.ts`'s parser rather than a shared helper, in this family's
 * style, and the three guard different pairs: that file asks "does herald-creds collide with
 * anything?", `translateCheckTiming.test.ts` asks it for herald-translate-check, and this one asks it
 * for herald-backup. Nothing asked it for :47 before this file existed.
 *
 * An array, not a single minute, because `herald-convert.timer` fires twice an hour
 * (`*-*-* *:07,37:00`) and both of its minutes are minutes this unit must avoid. `undefined` rather
 * than `[]` for an unreadable spec, so a shape this parser does not know fails the guard below
 * instead of quietly contributing no minutes to a check that then passes.
 */
function minutesOf(spec: string): string[] | undefined {
  const fields = /^(?:[A-Za-z]{3}(?:(?:\.\.|,)[A-Za-z]{3})* )?\S+ ([^\s:]+):([^\s:]+):([^\s:]+)$/.exec(spec.trim());
  if (!fields) return undefined;
  const minutes = fields[2].split(",");
  if (!minutes.every((m) => /^\d{1,2}$/.test(m))) return undefined;
  return minutes.map((m) => m.padStart(2, "0"));
}

const timerFiles = readdirSync(deployDir).filter((f) => f.endsWith(".timer")).sort();
const serviceFiles = readdirSync(deployDir).filter((f) => f.endsWith(".service")).sort();

describe("herald-backup.service — the lines whose absence fails silently", () => {
  it("aims state:push at the PRODUCTION database, which is the entire reason this unit exists", () => {
    // The finding's core, and the one assertion in this file that is worth the rest of it.
    //
    // `%h/.herald/prod.env` holds exactly two keys — DATABASE_URL and HERALD_DB_ENV — and a
    // shell-exported variable beats Node's `--env-file`, so this line and nothing else is what moves
    // the backup off the frozen .env's local-Docker DSN. Everything the upload needs
    // (GOOGLE_AUTH_MODE=oauth, the OAuth refresh token, GDRIVE_CONFIG_FOLDER_ID,
    // GDRIVE_STATE_FOLDER_ID) still comes from .env, which is why the unit needs no wiring of its
    // own and why the line looks omissible.
    //
    // Deleting it does not disable the backup. The timer fires, both commands exit 0, a snapshot
    // lands in Drive, and the log reports a row count — for the development database. Every other
    // test in the suite stays green, and the failure is invisible until the day someone restores.
    expect(service).toMatch(/^EnvironmentFile=%h\/\.herald\/prod\.env$/m);
  });

  it("pushes both bundles — the steering config AND the operational state", () => {
    // Two commands, not one, and neither is inferable from the other. `config:push` backs up the 13
    // steering files; `state:push` backs up the database, few-shot corpora included. Dropping the
    // second leaves a unit that still runs daily, still succeeds, and backs up none of the data the
    // spec was written about.
    expect(execStarts(service)).toHaveLength(2);
    expect(execStarts(service)[0]).toMatch(/\/pnpm config:push$/);
    expect(execStarts(service)[1]).toMatch(/\/pnpm state:push$/);
  });

  it("runs config:push BEFORE state:push, so a dead database still costs only half the backup", () => {
    // The order is a decision, not an accident: `config:push` is the cheap one and it cannot fail on
    // database state, so putting it first means an unreachable Neon compute still leaves the steering
    // snapshot taken. A `Type=oneshot` stops at the first ExecStart= that fails, which is what makes
    // the order load-bearing rather than cosmetic. Derived from the lines themselves so it cannot
    // agree with a copy of itself.
    const scripts = execStarts(service).map((l) => pnpmScriptOf(l));
    expect(scripts).toEqual(["config:push", "state:push"]);
  });

  it("reaches pnpm through the stable bin directory on EVERY line, not just the first", () => {
    // unitToolPaths.test.ts reads only the first ExecStart= of each service, so a versioned nvm path
    // on the second line — the failure that took out three units on 2026-08-09 — would land here
    // unnoticed. Both lines, checked separately.
    expect(execStarts(service)).toHaveLength(2);
    for (const line of execStarts(service)) {
      expect(line).toContain("%h/.herald/bin/pnpm");
      expect(line).not.toContain("/.nvm/versions/node/");
    }
  });

  it("runs every command through the run-logging wrapper with this unit's own name", () => {
    // Argument order is the wrapper's contract, not a convention: `$1` is the unit name and
    // everything after it is the command, run verbatim. Reversed, the wrapper names its log
    // directory after pnpm and runs the unit name as a command. Both lines carry the same `%n` so
    // both land in one per-unit directory — and under the key deploy/herald-notify-failure.sh derives
    // its fallback excerpt from. journald on this box holds roughly eight minutes of history against
    // a daily cadence, so the wrapper's log is the only durable record a backup run leaves.
    for (const line of execStarts(service)) {
      expect(line).toContain("%h/.herald/app/deploy/herald-run-logged.sh %n");
    }
  });

  it("is a oneshot, so the second ExecStart= is legal and the timeout covers the whole run", () => {
    // Any other Type= rejects a second ExecStart= outright, so a Type= edit would not merely change
    // the timing model — it would drop `state:push` entirely, which is the half this unit was built
    // for. It is also what makes TimeoutStartSec= apply to the run rather than to the spawn.
    expect(service).toMatch(/^Type=oneshot$/m);
  });

  it("alerts on failure through the shared hook, templated on its own unit name", () => {
    // A backup that stops running looks exactly like a backup that runs cleanly: no output anybody
    // reads, no dashboard, nothing. This hook is the only thing between a dead timer and finding out
    // at restore time. `%n`, not a literal target — a hardcoded one tails another unit's journal in
    // this one's alert (see deploy/herald-notify-failure@.service's header).
    expect(directives(service)).toContainEqual("OnFailure=herald-notify-failure@%n.service");
  });

  it("bounds its own run rather than inheriting a default nobody chose", () => {
    // Plain seconds, so this file can compare it. `undefined` here means the directive is missing or
    // uses a unit suffix ("5min"); either way a wedged run is bounded by whatever
    // DefaultTimeoutStartSec this box happens to have, a decision nobody in this repo made. The upper
    // bound is the family's sibling rule (timeout at or under half the fire period): systemd skips an
    // OnCalendar= fire that comes due while the unit is still active, so a wedged run must be killed
    // well before the next day's.
    const raw = /^TimeoutStartSec=(\d+)$/m.exec(directives(service).join("\n"))?.[1];
    expect(raw, "no plain-seconds TimeoutStartSec=").toBeDefined();
    expect(Number(raw)).toBeGreaterThan(0);
    expect(Number(raw)).toBeLessThanOrEqual(86_400 / 2);
  });
});

describe("herald-backup.timer", () => {
  it("fires once a day, at the minute the spec chose", () => {
    expect(onCalendarSpecs(timer)).toEqual(["*-*-* 05:47:00"]);
  });

  it("states its schedule exactly once, and only as an OnCalendar=", () => {
    // systemd accumulates OnCalendar= lines and adds OnUnitActiveSec=/OnUnitInactiveSec= as further
    // ways to set a period, so the real gap between fires can be shorter than the one line this file
    // reads. Refusing a set of directives this file does not model is the same discipline `minutesOf`
    // applies to a spec it cannot parse.
    expect(timer).not.toMatch(/^(OnUnitActiveSec|OnUnitInactiveSec)=/m);
    expect(service).not.toMatch(/^(OnCalendar|OnUnitActiveSec|OnUnitInactiveSec)=/m);
  });

  it("catches up a fire missed while the machine was off", () => {
    // Not cosmetic here. This is a WSL2 box whose user manager is routinely not running at 05:47, and
    // without this a machine that was off through the fire silently skips the day — so the backup
    // that exists for the day the database is lost is missing exactly on the days the machine was
    // having trouble.
    expect(directives(timer)).toContainEqual("Persistent=true");
  });

  it("can actually be enabled", () => {
    // A timer with no [Install] section is one `systemctl --user enable` refuses ("has no
    // installation config") — this project's recurring failure shape read backwards: the file is
    // copied, daemon-reload succeeds, and the only thing that ever says otherwise is a line in the
    // enable command's output that scrolls past. Every other timer in deploy/ carries both lines.
    expect(directives(timer)).toContainEqual("[Install]");
    expect(directives(timer)).toContainEqual("WantedBy=timers.target");
  });

  it("does not share a minute with any other scheduled unit", () => {
    // :47 against {07,37} convert, :17 watch, :23 creds, :41 x-reconcile, :53 translate-check. Units
    // sharing a minute buy nothing and invite two pnpm processes starting at once on a cold Neon
    // compute — and this one starts by uploading to Drive, so a collision costs bandwidth too.
    //
    // Both sides derived from deploy/. Writing :47 out here as a literal would make the check a
    // comparison between two copies of the same decision: moving the timer and updating the literal
    // in "fires once a day" but not this one leaves the suite green with a real collision.
    const others = timerFiles
      .filter((f) => f !== "herald-backup.timer")
      .flatMap((f) => onCalendarSpecs(read(f)).flatMap((spec) => minutesOf(spec) ?? []));
    const mine = onCalendarSpecs(timer).flatMap((spec) => minutesOf(spec) ?? []);
    expect(others.length, "no other timers found — the check would pass vacuously").toBeGreaterThan(0);
    expect(mine.length, "this timer's own minute could not be read").toBeGreaterThan(0);
    for (const minute of mine) {
      expect(others, `herald-backup.timer fires at :${minute}, and so does another timer`).not.toContain(minute);
    }
  });

  it("reads every OnCalendar= in deploy/, so the check above cannot pass by understanding none", () => {
    // The guard on the parser rather than on the units. A spec `minutesOf` cannot read contributes no
    // minutes, and a collision check fed no minutes passes — so an unreadable shape must fail here,
    // where the message says to teach the parser, instead of there, where it says nothing.
    const unreadable = timerFiles.flatMap((f) =>
      onCalendarSpecs(read(f))
        .filter((spec) => minutesOf(spec) === undefined)
        .map((spec) => `${f}: OnCalendar=${spec}`),
    );
    expect(unreadable, "teach minutesOf() these shapes before adding them").toEqual([]);
    expect(timerFiles.length).toBeGreaterThan(1);
  });

  it("reads the shapes it claims to read, and refuses the ones it does not", () => {
    // Without this, a `minutesOf` that returned `[]` for everything would satisfy the guard above and
    // silently empty the collision check.
    expect(minutesOf("*-*-* 05:47:00")).toEqual(["47"]);
    expect(minutesOf("*-*-* 0/2:17:00")).toEqual(["17"]);
    expect(minutesOf("*-*-* *:07,37:00")).toEqual(["07", "37"]);
    expect(minutesOf("Mon *-*-* 06:53:00")).toEqual(["53"]);
    for (const spec of ["Mondays *-*-* 17:00:00", "hourly", "daily", "*-*-* 0/6:41", ""]) {
      expect(minutesOf(spec), spec).toBeUndefined();
    }
  });
});

/**
 * The coupling `credsTiming.test.ts` opened and left half-closed. It derives one script per service
 * — from the FIRST `ExecStart=` — and checks `package.json` defines it, so on this unit `pnpm
 * config:push` is covered and `pnpm state:push` is not. Renaming `state:push` would leave every
 * suite green and the timer running a script `pnpm` refuses with `ERR_PNPM_NO_SCRIPT`: once a day, at
 * 05:47, as a Telegram alert about a backup that has not been taken since.
 *
 * Every line of every unit, derived from `deploy/`, because the same hole is open for
 * `herald-translate-check.service`'s second command and for whatever two-command unit is written next
 * by copying this one.
 */
describe("every ExecStart= in deploy/ runs a pnpm script that exists", () => {
  it("finds the units and the lines to check — an empty list would pass every case below", () => {
    expect(serviceFiles).toContain("herald-backup.service");
    expect(serviceFiles.length).toBeGreaterThan(1);
    // The line count is what this file adds over credsTiming's version, so it is the thing that must
    // not silently drop to one per unit.
    expect(execStarts(read("herald-backup.service"))).toHaveLength(2);
  });

  for (const file of serviceFiles) {
    const lines = execStarts(read(file));

    it(`${file} — ${lines.length} ExecStart= line(s)`, () => {
      for (const line of lines) {
        const script = pnpmScriptOf(line);
        if (script === undefined) {
          // e.g. herald-notify-failure@.service, which runs a shell script. Asserted rather than
          // skipped: a line that names pnpm in a spelling this file cannot read must fail here, not
          // fall through as "nothing to check".
          expect(line, "names pnpm but the script could not be read out of it").not.toMatch(/\bpnpm\b/);
          continue;
        }
        expect(
          Object.keys(pkg.scripts),
          `deploy/${file} runs \`pnpm ${script}\`, which package.json does not define`,
        ).toContain(script);
      }
    });
  }
});
