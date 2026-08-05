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

  it("exits 1 and names the failing stage and its detail on failure — even when the stage never appears in stagesRun", () => {
    // Modeled on a real agent failure, not a pnpm-stage one: `stagesRun` only ever records the
    // pnpm-script stage names WatchTick pushes onto it (collect, translate:prepare,
    // translate:align) — never an agent call's own stage name ("claude-agent:translation" /
    // "claude-agent:alignment", per ClaudeCodeAgent). A fixture whose failing stage also happens
    // to sit inside `stagesRun` can't tell "the line explicitly names the failing stage" apart
    // from "the line just happens to print stagesRun, which happens to contain the same
    // substring" — dropping the stage prefix from the failure line stayed green against exactly
    // that kind of fixture.
    const report: TickReport = {
      ok: false,
      stagesRun: ["collect", "translate:prepare"],
      failure: { stage: "claude-agent:translation", detail: "claude -p was denied permission for: Bash" },
    };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(1);
    // The joined "stage: detail" string, not just each substring independently present somewhere
    // in the line — a mutation that drops the stage prefix but keeps the detail would still pass
    // two separate `.toContain()` checks.
    expect(outcome.line).toContain("claude-agent:translation: claude -p was denied permission for: Bash");
  });

  it("stops after collect and still exits 0 when nothing new was found", () => {
    // The realistic "normal outcome" tick: only `collect` ran, agent never touched.
    const report: TickReport = { ok: true, stagesRun: ["collect"] };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toContain("collect");
  });
});
