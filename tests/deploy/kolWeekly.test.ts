import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const service = readFileSync("deploy/herald-kol-weekly.service", "utf8");
const timer = readFileSync("deploy/herald-kol-weekly.timer", "utf8");

describe("herald-kol-weekly", () => {
  it("runs the quarter sweep and nothing else", () => {
    const execs = service.split("\n").filter((l) => l.startsWith("ExecStart="));
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain("pnpm kol:quarter");
  });

  /** Every scheduled unit pages the ops room on failure; a silent weekly failure is invisible. */
  it("pages the ops room on failure", () => {
    expect(service).toContain("OnFailure=herald-notify-failure@%n.service");
  });

  it("runs from the deploy checkout with the production env, like its siblings", () => {
    expect(service).toContain("WorkingDirectory=%h/.herald/app");
    expect(service).toContain("EnvironmentFile=%h/.herald/prod.env");
  });

  it("fires weekly", () => {
    expect(timer).toMatch(/OnCalendar=\w{3} \*-\*-\* /);
    expect(timer).toContain("Persistent=true");
  });

  /** Sends and publishes are not this unit's business, the same rule the other six follow. */
  it("never sends or publishes", () => {
    for (const word of ["send:", "drive:publish", "format "]) expect(service).not.toContain(word);
  });
  /**
   * The header is the only place an operator reads before installing this unit, so a false claim in
   * it is an operational fault, not a typo. This one said the roster comes from `kol-map` — retired
   * since the 2026-08-19 roster move, and `LoadKolMap` has read `'KOL list'` ever since.
   */
  it("names 'KOL list' as the roster it reads, not the retired kol-map", () => {
    const header = service.split("[Unit]")[0]!;
    expect(header).toMatch(/roster \(`KOL list`/);
    expect(header).not.toMatch(/roster \(`kol-map`/);
  });

  /**
   * The other false claim: "the same fire that swept 2026-Q3 in August sweeps 2026-Q4 in November
   * unchanged". `GSHEET_ID` names ONE quarterly workbook, so from Oct 1 the command's own
   * `currentQuarter` default asks for `Oct.` in the Q3 workbook, `getValues` throws, and the run
   * dies every Tuesday until someone repoints it. That is an operator step, and it belongs in the
   * header rather than in the surprise.
   */
  it("states the quarter rollover as an operator step instead of claiming the unit never needs an edit", () => {
    expect(service).toContain("GSHEET_ID");
    expect(service).not.toContain("sweeps 2026-Q4 in November unchanged");
  });
});
