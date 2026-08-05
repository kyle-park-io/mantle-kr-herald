import type { StageResult, StageRunner, WorksheetAgent } from "../ports/WorksheetAgent";

export type TickReport = {
  ok: boolean;
  stagesRun: string[];
  failure?: { stage: string; detail: string };
};

const COLLECT_STAGE = "collect";
const PREPARE_STAGE = "translate:prepare";
const ALIGN_STAGE = "translate:align";

// `src/cli/collect.ts:42` prints exactly one line of this shape:
//   collected 3 threads (7 tweets) for @Mantle_Official — covered 2026-08-05T… ~ 2026-08-05T…
//   collected 0 threads (0 tweets) for @Mantle_Official — nothing new in window
// Only the leading count is load-bearing here; the rest of the line (coverage window,
// gap notice) is free text we don't need to parse.
const COLLECT_LINE = /^collected (\d+) threads \(\d+ tweets\) for @\S+ — /;

// `src/cli/translate-prepare.ts:56` prints this as the first of two lines — a second line (the
// `pnpm translate:save ... [--approve]` hint) always follows, so match a single line with the
// `m` flag rather than anchoring the whole buffer:
//   prepared 2 item(s) → output/translations/worksheets/batch-<stamp>.md
//   prepared 0 item(s) → output/translations/worksheets/batch-<stamp>.md
const PREPARED_LINE = /^prepared (\d+) item\(s\) → (.+)$/m;

// `src/cli/translate-align.ts` prints one of these two shapes (lines 42 and 36 respectively).
// The "aligned" shape is always followed by a second hint line. The "nothing to align" shape may
// carry an optional " — run `pnpm tm:promote` to add precedent pairs" suffix on the *same* line
// when skipped > 0, so that pattern is a prefix match rather than a full-line anchor:
//   aligned 2 · skipped 1 (no precedent) → output/translations/worksheets/align-<stamp>.md
//   nothing to align · skipped 1 (no precedent)
const ALIGNED_LINE = /^aligned (\d+) · skipped (\d+) \(no precedent\) → (.+)$/m;
const NOTHING_TO_ALIGN_LINE = /^nothing to align · skipped (\d+) \(no precedent\)/m;

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

type Prepared = { count: number; worksheetPath: string };

/** Same "unrecognised → undefined, caller must fail" contract as parseCollectedThreadCount. */
function parsePrepared(stdout: string): Prepared | undefined {
  const match = PREPARED_LINE.exec(stdout);
  if (!match) return undefined;
  return { count: Number(match[1]), worksheetPath: match[2] };
}

/**
 * Returns the worksheet path when `translate:align` produced one, `null` when it explicitly
 * aligned nothing, or `undefined` when the stdout matches neither known shape (caller must
 * treat that as a failure, same contract as the two parsers above).
 */
function parseAligned(stdout: string): { worksheetPath: string } | null | undefined {
  const alignedMatch = ALIGNED_LINE.exec(stdout);
  if (alignedMatch) return { worksheetPath: alignedMatch[3] };
  if (NOTHING_TO_ALIGN_LINE.test(stdout)) return null;
  return undefined;
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
    if (threadCount === 0) {
      return { ok: true, stagesRun };
    }

    const prepare = await this.runStage(PREPARE_STAGE, ["--limit", "3"]);
    stagesRun.push(PREPARE_STAGE);

    if (!prepare.ok) {
      return this.fail(stagesRun, prepare);
    }

    const prepared = parsePrepared(prepare.stdout);
    if (prepared === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: PREPARE_STAGE,
        detail: `unrecognised translate:prepare output: "${prepare.stdout}"`,
      });
    }

    // `translate-prepare.ts` writes a worksheet unconditionally, even for a zero-item batch —
    // calling the agent on it would spend a subscription turn translating nothing. This happens
    // whenever `collect` re-reads a thread that is already translated.
    if (prepared.count > 0) {
      const translation = await this.agent.fill(prepared.worksheetPath, "translation");
      if (!translation.ok) {
        return this.fail(stagesRun, translation);
      }
    }

    const align = await this.runStage(ALIGN_STAGE, ["--limit", "3"]);
    stagesRun.push(ALIGN_STAGE);

    if (!align.ok) {
      return this.fail(stagesRun, align);
    }

    const aligned = parseAligned(align.stdout);
    if (aligned === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: ALIGN_STAGE,
        detail: `unrecognised translate:align output: "${align.stdout}"`,
      });
    }

    if (aligned !== null) {
      const alignment = await this.agent.fill(aligned.worksheetPath, "alignment");
      if (!alignment.ok) {
        return this.fail(stagesRun, alignment);
      }
    }

    return { ok: true, stagesRun };
  }

  private fail(stagesRun: string[], failure: Extract<StageResult, { ok: false }>): TickReport {
    return { ok: false, stagesRun, failure: { stage: failure.stage, detail: failure.detail } };
  }
}
