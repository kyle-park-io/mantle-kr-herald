// tests/docs/schedulerOverview.test.ts
//
// `docs/ko/schedulers.md` answers one question the runbook could not: "what schedulers exist, and
// what does each one do?" It answers it with a TABLE — five unit names against five `OnCalendar=`
// specs — and a table is the most rot-prone thing this repository writes down. It restates in
// Markdown a fact whose only real home is `deploy/*.timer`, and nothing about editing a timer makes
// anybody open a document. The failure is silent in the worst direction, too: a sixth timer added
// without a doc update leaves an overview that reads as complete and is not, which is worse than no
// overview at all, because the reader stops looking.
//
// So the table is pinned against `deploy/` in both directions, the way
// `tests/docs/koDocs.test.ts` pins the runbook's systemd install list and the way
// `tests/deploy/credsTiming.test.ts` derives every other timer's minute from the directory rather
// than listing them. Neither direction is redundant: one catches a unit added without touching the
// doc, the other catches a doc naming a unit that was renamed or deleted.
//
// WHAT THIS FILE DELIBERATELY DOES NOT CHECK. The prose. Everything in `schedulers.md` other than
// the three columns below — why the cadence is what it is, what the schedulers refuse to do, which
// commands stay manual — is argued in the `deploy/` unit headers and in the runbook sections the
// document links to, and a test that tried to pin Korean prose against those would either compare
// two copies of the same sentence or give up. The `tests/deploy/*Timing.test.ts` family already owns
// each unit's own directives (`Persistent=`, `[Install]`, `TimeoutStartSec=`, `EnvironmentFile=`),
// and `koDocs.test.ts` owns the install list and the link/command checks across all of `docs/ko/`.
// What is left — and what nothing else in the suite can see — is the correspondence between the
// overview's rows and the directory, which is exactly the part a reader trusts without checking.
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/paths";

const deployDir = join(REPO_ROOT, "deploy");
const overviewPath = join(REPO_ROOT, "docs", "ko", "schedulers.md");

/**
 * Directives only. Every unit in `deploy/` quotes old specs, rejected cadences and other units'
 * minutes in its comments to explain the incident that produced it —
 * `herald-translate-check.timer` alone names `*-*-* *:07,37:00`, `0/2:17:00`, `0/6:41:00` and
 * `06:23:00` in prose — so a reader of these files that did not strip comments would pick up four
 * schedules that belong to other units. The same split `tests/deploy/credsTiming.test.ts` makes,
 * for the same reason.
 */
const directives = (unit: string): string[] =>
  unit.split("\n").filter((l) => !l.trimStart().startsWith("#") && l.trim() !== "");

const onCalendarSpecs = (unit: string): string[] =>
  directives(unit)
    .filter((l) => l.startsWith("OnCalendar="))
    .map((l) => l.slice("OnCalendar=".length).trim());

/** Every pnpm script an `ExecStart=` names — `["translate:check", "glossary:mine"]` for the digest. */
const pnpmScripts = (unit: string): string[] =>
  directives(unit)
    .filter((l) => l.startsWith("ExecStart="))
    .map((l) => /\bpnpm\s+([a-z][a-z0-9:_-]*)/.exec(l)?.[1])
    .filter((s): s is string => s !== undefined);

interface Row {
  readonly unit: string;
  readonly schedule: string;
  readonly runs: string;
}

/**
 * The overview's schedule rows: a Markdown table row whose first cell is a backticked `herald-…`
 * unit name and whose second is a backticked anything.
 *
 * Identified by SHAPE rather than by position or by a marker comment, the same choice
 * `koDocs.test.ts` makes about the install block and for the same reason — a heading can be
 * renamed and a marker can be deleted, while this shape is what the row IS. The consequence is
 * deliberate: if a second table in this document ever gives a `herald-…` unit a backticked second
 * cell, it is picked up here and fails as a duplicate rather than being silently skipped. Failing
 * loudly with "reshape that table" beats a filter that quietly decides which rows count, which is
 * how a check ends up grading only the rows that already pass.
 */
function scheduleRows(markdown: string): Row[] {
  return [...markdown.matchAll(/^\|\s*`(herald-[a-z0-9-]+)`\s*\|\s*`([^`|]+)`\s*\|([^\n]*)$/gm)].map((m) => ({
    unit: m[1],
    schedule: m[2].trim(),
    runs: m[3],
  }));
}

describe("docs/ko/schedulers.md", () => {
  it("names every timer in deploy/, and no unit that is not one", async () => {
    // The half that catches a sixth scheduler. Adding `deploy/herald-something.timer` fails here
    // until the overview grows a row for it — which is the whole point of the document: a reader
    // who has to check `deploy/` to find out whether the list is complete has no overview.
    const rows = scheduleRows(await readFile(overviewPath, "utf8"));
    const timerFiles = (await readdir(deployDir)).filter((f) => f.endsWith(".timer")).sort();

    expect(timerFiles.length, "no .timer files found — every check here would pass vacuously").toBeGreaterThan(0);
    expect(rows.length, "no schedule rows found — the table's shape changed, or the file moved").toBeGreaterThan(0);

    const listed = rows.map((r) => r.unit).sort();
    // Before comparing sets: a repeated unit means two rows claim the same schedule, and a set
    // comparison would happily accept a table that contradicts itself.
    expect([...new Set(listed)], "the same unit appears in more than one row").toEqual(listed);
    expect(listed).toEqual(timerFiles.map((f) => f.replace(/\.timer$/, "")));
  });

  it("gives each unit the OnCalendar= its own timer file carries", async () => {
    // The half that catches a cadence CHANGE, which is the likelier edit and the quieter one: the
    // set of units is stable for months at a time, while `*-*-* 0/2:17:00` becoming `*-*-* *:17:00`
    // is described in `herald-watch.timer`'s own header as "a one-line change". Written out per
    // unit rather than as one set comparison so the failure message names which row lies.
    const rows = scheduleRows(await readFile(overviewPath, "utf8"));
    const documented = new Map(rows.map((r) => [r.unit, r.schedule]));

    for (const file of (await readdir(deployDir)).filter((f) => f.endsWith(".timer")).sort()) {
      const unit = file.replace(/\.timer$/, "");
      const specs = onCalendarSpecs(await readFile(join(deployDir, file), "utf8"));
      // A timer may legally accumulate several OnCalendar= lines; none in this directory does, and
      // a table with one cell per unit could not honestly show one that did. Asserted rather than
      // joined into a string, so that shape arrives here — where the message says the table needs
      // rethinking — instead of as a mismatch that reads like a typo.
      expect(specs, `deploy/${file} states its schedule in ${specs.length} OnCalendar= lines`).toHaveLength(1);
      expect(documented.get(unit), `docs/ko/schedulers.md's \`${unit}\` row`).toBe(specs[0]);
    }
  });

  it("names, in each row, every pnpm script that unit actually runs", async () => {
    // The third column is prose, so this pins the one part of it that is a fact: the commands. It
    // is what catches `herald-translate-check` growing a third `ExecStart=` — the edit that added
    // its second one is the reason this document had no section of its own on the day it shipped —
    // and a `pnpm` script renamed underneath a row that still names the old one.
    //
    // Containment, not equality: the column deliberately says more than the ExecStart= does,
    // because `pnpm convert:tick` is a wrapper whose interesting content (`convert:prepare`, the
    // agent, `format --only-missing`) is invisible from the unit file.
    const rows = scheduleRows(await readFile(overviewPath, "utf8"));
    const documented = new Map(rows.map((r) => [r.unit, r.runs]));
    const missing: string[] = [];

    for (const file of (await readdir(deployDir)).filter((f) => f.endsWith(".timer")).sort()) {
      const unit = file.replace(/\.timer$/, "");
      const scripts = pnpmScripts(await readFile(join(deployDir, `${unit}.service`), "utf8"));
      expect(scripts, `deploy/${unit}.service runs no readable pnpm script`).not.toEqual([]);
      for (const script of scripts) {
        if (!(documented.get(unit) ?? "").includes(script)) missing.push(`${unit} → ${script}`);
      }
    }

    expect(missing, "these commands run on a schedule and the overview's row does not name them").toEqual([]);
  });
});
