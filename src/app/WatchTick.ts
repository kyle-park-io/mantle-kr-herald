import type { StageResult, StageRunner, WorksheetAgent } from "../ports/WorksheetAgent";

export type TickReport = {
  ok: boolean;
  stagesRun: string[];
  failure?: { stage: string; detail: string };
};

const COLLECT_STAGE = "collect";

// `src/cli/collect.ts:42` prints exactly one line of this shape:
//   collected 3 threads (7 tweets) for @Mantle_Official — covered 2026-08-05T… ~ 2026-08-05T…
//   collected 0 threads (0 tweets) for @Mantle_Official — nothing new in window
// Only the leading count is load-bearing here; the rest of the line (coverage window,
// gap notice) is free text we don't need to parse.
const COLLECT_LINE = /^collected (\d+) threads \(\d+ tweets\) for @\S+ — /;

/**
 * Returns the thread count `collect` reported, or `undefined` if the stdout doesn't match the
 * known shape at all. Unrecognised stdout must be treated as a failure by the caller — never as
 * "nothing new" — or a broken collector reads as a scheduler that succeeds forever while doing
 * nothing.
 */
function parseCollectedThreadCount(stdout: string): number | undefined {
  const match = COLLECT_LINE.exec(stdout.trim());
  if (!match) return undefined;
  return Number(match[1]);
}

export class WatchTick {
  private readonly runStage: StageRunner;
  private readonly agent: WorksheetAgent;

  constructor(run: StageRunner, agent: WorksheetAgent) {
    this.runStage = run;
    this.agent = agent;
  }

  async run(): Promise<TickReport> {
    const stagesRun: string[] = [];

    const collect = await this.runStage(COLLECT_STAGE, []);
    stagesRun.push(COLLECT_STAGE);

    if (!collect.ok) {
      return this.fail(stagesRun, collect);
    }

    const threadCount = parseCollectedThreadCount(collect.stdout);
    if (threadCount === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: COLLECT_STAGE,
        detail: `unrecognised collect output: "${collect.stdout}"`,
      });
    }

    // Zero new threads: nothing downstream has work to do, and the agent is never touched.
    // A non-zero count has no later stage to hand off to yet — that sequencing arrives in
    // Task 2 — so for now the tick simply stops here having done its one job.
    return { ok: true, stagesRun };
  }

  private fail(stagesRun: string[], failure: Extract<StageResult, { ok: false }>): TickReport {
    return { ok: false, stagesRun, failure: { stage: failure.stage, detail: failure.detail } };
  }
}
