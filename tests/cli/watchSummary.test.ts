import { describe, it, expect } from "vitest";
import { watchOutcome } from "../../src/cli/watchSummary";
import type { TickReport } from "../../src/app/WatchTick";

describe("watchOutcome", () => {
  it("exits 0 and names every stage that ran, in order, on success", () => {
    const report: TickReport = { ok: true, stagesRun: ["collect", "translate:prepare", "translate:align"] };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(0);
    // Not just "contains collect somewhere" — a canned success line that never reads `stagesRun`
    // would also satisfy that. Pin the full ordered sequence.
    expect(outcome.line).toContain("collect → translate:prepare → translate:align");
  });

  it("exits 1 and names the failing stage and its detail on failure", () => {
    const report: TickReport = {
      ok: false,
      stagesRun: ["collect", "translate:prepare"],
      failure: { stage: "translate:prepare", detail: "ECONNREFUSED" },
    };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.line).toContain("translate:prepare");
    expect(outcome.line).toContain("ECONNREFUSED");
  });

  it("stops after collect and still exits 0 when nothing new was found", () => {
    // The realistic "normal outcome" tick: only `collect` ran, agent never touched.
    const report: TickReport = { ok: true, stagesRun: ["collect"] };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toContain("collect");
  });
});
