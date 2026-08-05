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

  it("keeps a huge multi-line detail down to one line the failure alert can still show whole", () => {
    // The alert path, end to end: this line is printed with `console.log`, journald stores one
    // entry per line, `deploy/herald-notify-failure.sh` reads the last 5 entries back with
    // `journalctl -n 5` and then keeps only the last 500 characters. So a multi-line detail costs
    // the alert its prefix twice over — once by filling all five entries, once by the tail-slice —
    // and the operator's phone shows the middle of a stack trace with nothing naming the stage.
    // `runStage` caps the stderr it puts in a detail, but not every detail comes from there:
    // `ClaudeCodeAgent` builds its own, and this is the last place any of them can be bounded.
    const report: TickReport = {
      ok: false,
      stagesRun: ["collect", "translate:prepare"],
      failure: {
        stage: "translate:prepare",
        detail: `Error: connect ETIMEDOUT\n${"    at Socket.onTimeout (node:net:1234:5)\n".repeat(60)}`,
      },
    };

    const { line } = watchOutcome(report);

    expect(line).not.toContain("\n");
    // What the hook actually reads. The prefix has to survive its tail-slice, not merely exist.
    expect(line.slice(-500)).toContain("watch: FAILED — translate:prepare:");
    expect(line).toContain("Error: connect ETIMEDOUT");
    // The stage list is at the end of the line, so it is the first thing an unbounded detail
    // would push out.
    expect(line).toContain("(ran collect → translate:prepare)");
  });

  it("stops after collect and still exits 0 when nothing new was found", () => {
    // The realistic "normal outcome" tick: only `collect` ran, agent never touched.
    const report: TickReport = { ok: true, stagesRun: ["collect"] };
    const outcome = watchOutcome(report);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.line).toContain("collect");
  });
});
