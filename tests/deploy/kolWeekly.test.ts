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
});
