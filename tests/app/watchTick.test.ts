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
});
