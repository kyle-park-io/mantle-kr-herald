// tests/app/watchTick.test.ts
import { describe, it, expect } from "vitest";
import { WatchTick } from "../../src/app/WatchTick";
import type { StageResult, WorksheetAgent } from "../../src/ports/WorksheetAgent";

function recordingAgent() {
  const calls: string[] = [];
  const agent: WorksheetAgent = {
    async fill(_path, kind) {
      calls.push(kind);
      return { ok: true, stdout: "saved" };
    },
  };
  return { agent, calls };
}

describe("WatchTick", () => {
  it("stops after collect when nothing is new, without calling the agent", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      return { ok: true, stdout: "collected 0 threads (0 tweets) for @x — nothing new in window" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });

  it("reports the failing stage and runs nothing after it", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      return { ok: false, stage: script, detail: "ECONNREFUSED" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "collect", detail: "ECONNREFUSED" });
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });

  it("runs both agent passes in order when there is work", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      ran.push([script, ...args].join(" "));
      if (script === "collect") return { ok: true, stdout: "collected 2 threads (5 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
      // Real `translate-align.ts:42` always includes "(no precedent)" in this line.
      return { ok: true, stdout: "aligned 2 · skipped 0 (no precedent) → output/translations/worksheets/align-X.md" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(calls).toEqual(["translation", "alignment"]);
    expect(ran).toEqual([
      "collect",
      "translate:prepare --limit 3",
      "translate:align --limit 3",
    ]);
  });

  it("translates but skips alignment when there is no precedent", async () => {
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: "nothing to align · skipped 1 (no precedent)" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "translate:align"]);
    // Not `[]` — the translation pass must still have run. Asserting only the
    // absence of "alignment" would also pass if the tick did nothing at all.
    expect(calls).toEqual(["translation"]);
  });

  it("skips the translation pass when the batch prepared nothing", async () => {
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 0 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: "nothing to align · skipped 0 (no precedent)" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(calls).toEqual([]);
  });

  it("never passes --approve to any stage", async () => {
    const { agent } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      ran.push([script, ...args].join(" "));
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
    };

    await new WatchTick(run, agent).run();

    expect(ran.length).toBeGreaterThan(1); // guard: a no-op tick would pass vacuously
    expect(ran.join(" ")).not.toContain("--approve");
  });

  // Task 1's "reports the failing stage" test only ever exercised `collect`, so it couldn't
  // distinguish a genuine pass-through of `failure.stage` from a hardcoded "collect". This test
  // fails a later stage instead, to make that assertion discriminating.
  it("reports a later stage's failure, not just collect's", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      ran.push([script, ...args].join(" "));
      if (script === "collect") return { ok: true, stdout: "collected 1 threads (2 tweets) for @x — covered a ~ b" };
      if (script === "translate:prepare")
        return { ok: true, stdout: "prepared 2 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: false, stage: script, detail: "ECONNREFUSED" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "translate:align", detail: "ECONNREFUSED" });
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(ran).toEqual([
      "collect",
      "translate:prepare --limit 3",
      "translate:align --limit 3",
    ]);
    expect(calls).toEqual(["translation"]);
  });
});
