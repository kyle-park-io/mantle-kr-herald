import { agentStage, type StageResult, type StageRunner, type WorksheetAgent } from "../ports/WorksheetAgent";
import type { TickReport } from "./TickReport";
import { DEFAULT_CONVERT_BATCH } from "../cli/convertBatch";

/**
 * One tick of the conversion scheduler: `convert:prepare`, then — only if it prepared anything — one
 * `claude -p` pass over the worksheet, then a check that the pass actually saved what it was given.
 *
 * It exists because the pipeline was automated up to `translated` and stopped there. After a human
 * approves in 1차 검수, turning that approval into channel variants was a manual `convert:prepare` +
 * agent + `convert:save`, so in practice the work went out by hand and the pipeline was bypassed.
 * Pre-rendering the variants means 2차 검수 is already populated when a reviewer arrives.
 *
 * **It stops at `converted`, and that is the whole design.** Nothing here formats, publishes or
 * sends: whether a variant ever reaches X, Telegram or Typefully is what 2차 검수 decides, and an
 * unattended scheduler must not pre-empt that. `ClaudeCodeAgent`'s allowlist is the structural half
 * of the same rule — the only shell command the agent can run at all is `pnpm convert:save`.
 *
 * `WatchTick` is the pattern this follows, guard for guard; where the reasoning is identical it is
 * not restated here. The differences that matter:
 *   - one agent pass per tick, not two, so the timeout arithmetic in `deploy/herald-convert.service`
 *     is 600s (one `claude -p`) rather than 1200s.
 *   - the "did the agent save anything?" check reads `pnpm status`'s Converted total instead of its
 *     Translated one — see `convertedCount` below.
 *   - approved-only selection is NOT re-implemented here. `PrepareConversions` already filters
 *     `status === "approved"` (`src/app/PrepareConversions.ts`), which is the gate that keeps an
 *     unreviewed translation from being converted; a second copy of that rule in this file would be
 *     a second place for it to drift.
 */

const PREPARE_STAGE = "convert:prepare";
const STATUS_STAGE = "status";

// `src/cli/convert-prepare.ts` prints exactly one of two first lines, both built by
// `src/cli/convertPrepareLines.ts` (which explains why they are built there and not inline):
//   prepared 3 variant(s) → output/variants/worksheets/batch-<stamp>.md
//   prepared 0 variant(s) — nothing approved is waiting to be converted
// A second line — the `pnpm convert:save …` hint — follows the first shape, so both patterns match a
// single line with the `m` flag rather than anchoring the whole buffer.
//
// `m` is also load-bearing for a reason that has nothing to do with this stage: every stage is
// spawned as `pnpm <script>` (`src/adapters/agent/runStage.ts`), and pnpm writes its own lines —
// `Already up to date`, `Done in 463ms using pnpm v11.20.0` — to *stdout*, ahead of and after the
// script's own output, whenever it does install work. Anchoring at the start of the buffer makes one
// such leading line fail every single tick.
const PREPARED_LINE = /^prepared (\d+) variant\(s\) → (.+)$/m;

// A prefix match, not a full-line anchor, and deliberately so: the zero case is the one most likely
// to grow an explanatory suffix later ("… — 12 approved, all converted"), and a tick that started
// failing over a friendlier message would be a self-inflicted outage. The count and the worksheet
// path are what must be read exactly; "there was nothing to do" is not.
const NOTHING_TO_CONVERT_LINE = /^prepared 0 variant\(s\) — /m;

// `src/status/pipeline.ts`'s `formatStatus` pads the label column to the widest label and the count
// column to the widest count, so both runs of spaces are variable:
//   Pipeline status
//
//     Translated             41   (pending 2 · approved 12 · posted 27)
//     Converted (variants)   30   (12 items · approved 4)
// Only the Converted total is read here — see `convertedCount` below for what it is for. The label
// carries literal parentheses; they are escaped, not a group.
const CONVERTED_LINE = /^\s*Converted \(variants\)\s+(\d+)/m;

type Prepared = { count: number; worksheetPath: string };

/**
 * The batch `convert:prepare` reported and the worksheet it wrote, `null` when it explicitly
 * prepared nothing, or `undefined` when the stdout matches neither known shape.
 *
 * Unrecognised stdout must be treated as a failure by the caller — never as "nothing to do" — or a
 * broken prepare reads as a scheduler that succeeds forever while doing nothing. Same contract as
 * every parser in `WatchTick`.
 */
function parsePrepared(stdout: string): Prepared | null | undefined {
  const match = PREPARED_LINE.exec(stdout);
  if (match) return { count: Number(match[1]), worksheetPath: match[2] };
  if (NOTHING_TO_CONVERT_LINE.test(stdout)) return null;
  return undefined;
}

/** Same "unrecognised → undefined, caller must fail" contract as the parser above. */
function parseConvertedCount(stdout: string): number | undefined {
  const match = CONVERTED_LINE.exec(stdout);
  if (!match) return undefined;
  return Number(match[1]);
}

export type ConvertTickOptions = {
  /**
   * Items handed to `convert:prepare --limit`. Items, not variants: one approved translation fans
   * out to as many variants as it has not-yet-converted types (up to six, `ALL_TYPES`), and it is
   * the variants that decide how long the single `claude -p` call takes. Omitted means
   * `DEFAULT_CONVERT_BATCH`, the value a hand-run `pnpm convert:tick` with nothing in the
   * environment gets and the one the scheduler is armed with. Validated and normalised to a positive
   * integer by `parseConvertBatch` (`src/cli/convertBatch.ts`) before it reaches here — this class
   * does no I/O and reads no environment, so the CLI is where that happens.
   */
  batch?: number;
};

export class ConvertTick {
  private readonly runStage: StageRunner;
  private readonly agent: WorksheetAgent;
  private readonly batch: number;

  constructor(run: StageRunner, agent: WorksheetAgent, options: ConvertTickOptions = {}) {
    this.runStage = run;
    this.agent = agent;
    this.batch = options.batch ?? DEFAULT_CONVERT_BATCH;
  }

  async run(): Promise<TickReport> {
    const stagesRun: string[] = [];

    // `--limit` and nothing else. `--types` would silently narrow what the scheduler ever produces
    // (an item converted for only some of its types still looks converted on the board), and `--ids`
    // would pin every tick to the same item forever.
    const prepare = await this.runStage(PREPARE_STAGE, ["--limit", String(this.batch)]);
    stagesRun.push(PREPARE_STAGE);

    if (!prepare.ok) {
      return this.fail(stagesRun, prepare);
    }

    const prepared = parsePrepared(prepare.stdout);
    if (prepared === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: PREPARE_STAGE,
        detail: `unrecognised convert:prepare output: "${prepare.stdout}"`,
      });
    }

    // Nothing approved is waiting: the common outcome at this cadence, and the whole point of the
    // gate. `prepared === null` is the current CLI saying so; `count === 0` is the same statement
    // from an older one that still wrote a worksheet for an empty batch — calling the agent on that
    // spends a subscription turn converting nothing. The tick and the CLI deploy together, so the
    // second branch should be unreachable, but a version skew between them is exactly the kind of
    // thing that is only noticed by the bill.
    if (prepared === null || prepared.count === 0) {
      return { ok: true, stagesRun };
    }

    // Bracket the agent pass with the one number that proves it did the job. A clean `claude -p` —
    // exit 0, `is_error: false`, no `permission_denials` — proves the process ran and was never
    // blocked; it does NOT prove the model ever called `convert:save`. A model that reads the
    // worksheet, decides it is done, and stops has exactly the same envelope as one that saved every
    // variant.
    //
    // `pnpm status`'s Converted total, not a re-run of `convert:prepare` with a "did the count drop?"
    // rule: `PrepareConversions` selects the first `--limit` of *every* approved item, so with a
    // backlog larger than the limit the count is identical before and after a perfect pass — that
    // rule would fail the tick hardest exactly when the scheduler is working hardest. The Converted
    // total has no such ambiguity: `convert:prepare` only ever hands over (itemId, type) pairs with
    // no variant row at all (`listConvertedKeys`), and the status line counts rows, so each save
    // moves it by exactly one. It is also a read-only query with no worksheet or `pending.json` side
    // effects, which a second `convert:prepare` would very much have — it archives the batch the
    // agent was just working on.
    const before = await this.convertedCount(stagesRun);
    if (typeof before !== "number") {
      return this.fail(stagesRun, before);
    }

    const conversion = await this.agent.fill(prepared.worksheetPath, "conversion");
    if (!conversion.ok) {
      return this.fail(stagesRun, conversion);
    }

    const after = await this.convertedCount(stagesRun);
    if (typeof after !== "number") {
      return this.fail(stagesRun, after);
    }

    // Fails the tick, deliberately, rather than warning: an unsaved batch is invisible downstream.
    // The item stays approved-and-unconverted, so the next tick re-selects it and the one after that
    // does too — the symptom is a 2차 검수 board that never fills, which looks exactly like "nothing
    // has been approved lately", and each later `convert:prepare` archives the unsaved batch on its
    // way past. A warning in a journal nobody reads is how that stays unnoticed for days.
    if (after - before < prepared.count) {
      return this.fail(stagesRun, {
        ok: false,
        stage: agentStage("conversion"),
        detail:
          `claude -p exited cleanly but saved ${after - before} of the ${prepared.count} variant(s) it was given ` +
          `(converted count ${before} → ${after})`,
      });
    }

    return { ok: true, stagesRun };
  }

  /**
   * How many variants exist right now, per `pnpm status` — or the failure to report when that stage
   * either failed outright or printed something this doesn't recognise. Unrecognised stdout is a
   * failure here for the same reason it is everywhere else in this file: a status line that stopped
   * matching would otherwise silently disable the check that depends on it.
   */
  private async convertedCount(stagesRun: string[]): Promise<number | Extract<StageResult, { ok: false }>> {
    const result = await this.runStage(STATUS_STAGE, []);
    stagesRun.push(STATUS_STAGE);

    if (!result.ok) return result;

    const count = parseConvertedCount(result.stdout);
    if (count === undefined) {
      return { ok: false, stage: STATUS_STAGE, detail: `unrecognised status output: "${result.stdout}"` };
    }
    return count;
  }

  private fail(stagesRun: string[], failure: Extract<StageResult, { ok: false }>): TickReport {
    return { ok: false, stagesRun, failure: { stage: failure.stage, detail: failure.detail } };
  }
}
