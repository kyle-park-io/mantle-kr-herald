import { agentStage, type StageResult, type StageRunner, type WorksheetAgent } from "../ports/WorksheetAgent";
import type { TickReport } from "./TickReport";
import { DEFAULT_CONVERT_BATCH } from "../cli/convertBatch";
import { ONLY_MISSING_FLAG, WARNING_PREFIX } from "../cli/formatLines";

/**
 * One tick of the conversion scheduler: `convert:prepare`, then — only if it prepared anything — one
 * `claude -p` pass over the worksheet, then a check that the pass actually saved what it was given,
 * then `format` for the pairs that have no rendering yet.
 *
 * It exists because the pipeline was automated up to `translated` and stopped there. After a human
 * approves in 1차 검수, turning that approval into channel variants was a manual `convert:prepare` +
 * agent + `convert:save`, so in practice the work went out by hand and the pipeline was bypassed.
 * Pre-rendering the variants means 2차 검수 is already populated when a reviewer arrives.
 *
 * **It stops at `rendered`, and that is the whole design.** Nothing here publishes or sends: whether
 * a variant ever reaches X, Telegram or Typefully is what 2차 검수 decides, and an unattended
 * scheduler must not pre-empt that. `ClaudeCodeAgent`'s allowlist is the structural half of the same
 * rule — the only shell command the agent can run at all is `pnpm convert:save`, and the send/publish
 * commands are denied outright.
 *
 * It stopped at `converted` until the format stage was added, which was one stage short of its own
 * purpose: the 2차 검수 board is built from `renderings`, not from `variants`
 * (`src/adapters/web/board.ts`), so an item this tick converted still showed "이 항목은 아직 렌더링이
 * 없습니다. `pnpm format` 을 먼저 실행하세요" and offered the reviewer no button. `rendered` is not a
 * step closer to publishing than `converted` was — `SendChannels` sends only `approved` renderings,
 * and approving one is the human act this whole tick exists to prepare for.
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
const FORMAT_STAGE = "format";

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

// `src/cli/format.ts` prints exactly one of two first lines, both built by `src/cli/formatLines.ts`
// (which explains why they are built there and not inline):
//   formatted 6 rendering(s) → the database (renderings)
//   formatted 0 rendering(s) — nothing is waiting to be formatted
// Warning lines may follow either, so both patterns match a single line with `m` rather than
// anchoring the whole buffer — and `m` is load-bearing for pnpm's own stdout lines besides, exactly
// as it is for PREPARED_LINE above.
//
// The `→` half is not captured: unlike `convert:prepare`, whose path the tick has to hand to the
// agent, nothing downstream of this stage reads its destination. Only the count is read, and only
// to tell "it did something" from "it had nothing to do" in the journal.
const FORMATTED_LINE = /^formatted (\d+) rendering\(s\) → /m;

// A prefix match, not a full-line anchor, for the same reason `NOTHING_TO_CONVERT_LINE` is one: the
// zero case is the one most likely to grow an explanatory suffix later, and a tick that started
// failing over a friendlier message would be a self-inflicted outage.
const NOTHING_TO_FORMAT_LINE = /^formatted 0 rendering\(s\) — /m;

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

/**
 * How many renderings `pnpm format` wrote — `0` when it explicitly wrote none, `undefined` when the
 * stdout matches neither known shape. Same contract as every parser above, and it matters as much
 * here as anywhere: "formatted nothing" is this stage's normal outcome, so a line that stopped
 * matching would be indistinguishable from a quiet week if unrecognised output were let through.
 */
function parseFormatted(stdout: string): number | undefined {
  const match = FORMATTED_LINE.exec(stdout);
  if (match) return Number(match[1]);
  if (NOTHING_TO_FORMAT_LINE.test(stdout)) return 0;
  return undefined;
}

/**
 * The `⚠` lines `pnpm format` prints under its summary — over-length emissions and anything else
 * `FormatVariants` flagged about the text it just wrote.
 *
 * Read out of stdout rather than recomputed, because this process never sees the renderings: the
 * stage is a subprocess and the warnings exist only in the text it printed. `\r` is trimmed because
 * these lines are compared and then re-printed, and a carriage return that survives into the journal
 * is invisible right up until someone greps for one of them.
 */
function parseWarnings(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.startsWith(WARNING_PREFIX));
}

export type ConvertTickOptions = {
  /**
   * Items handed to `convert:prepare --limit`. Items, not variants: one approved translation fans
   * out to as many variants as it has not-yet-converted types (up to seven, `ALL_TYPES`), and it is
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
    //
    // It skips the agent pass, NOT the whole tick — this used to be an early return, and the format
    // stage below runs either way. What the gate protects is the `claude -p` subscription turn, and
    // formatting spends none; see `format`'s own comment for the backlog that would otherwise be
    // stranded on every quiet fire.
    if (prepared !== null && prepared.count > 0) {
      const failed = await this.convert(stagesRun, prepared);
      if (failed) return failed;
    }

    return this.format(stagesRun);
  }

  /**
   * The agent half: bracket one `claude -p` pass with the count that proves it saved what it was
   * given. Returns the failing `TickReport` if anything went wrong, or `undefined` to carry on.
   *
   * Split out of `run` when the format stage arrived, so that "the agent pass and its verification"
   * stays one unit that either completes or ends the tick, and the stage that follows it is not
   * nested three levels inside its success path.
   */
  private async convert(stagesRun: string[], prepared: Prepared): Promise<TickReport | undefined> {
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

    return undefined;
  }

  /**
   * The last stage: turn variants into the channel renderings the 2차 검수 board is actually built
   * from (`src/adapters/web/board.ts` computes its `unconverted` list from rendering keys, so a
   * converted-but-unrendered item shows "아직 렌더링이 없습니다" and offers the reviewer no button).
   *
   * **`--only-missing`, and never anything else.** A bare `pnpm format` rebuilds every rendering in
   * the database from its variant at `status: "rendered"`, `refined: false` — discarding the text a
   * reviewer edited on the board and the approval they gave it. That is the right behaviour for
   * `[포맷 다시]` and for a hand run, where a human confirms the loss first; on a 30-minute timer it
   * is 2차 검수's work erased 48 times a day with a green tick each time. The flag is the whole
   * safety property of this stage, which is why it is spelled once, in `src/cli/formatLines.ts`,
   * shared with the CLI that reads it.
   *
   * No `--ids` either, and that is what makes this stage run unconditionally rather than only after
   * a pass that converted something. A variant can exist with no rendering for reasons this tick had
   * no part in — an earlier tick that failed after `convert:save`, a hand-run `convert:save`, a
   * rendering lost in a migration — and none of those would ever be picked up if formatting were
   * gated on this tick's own agent pass. The cost of being wrong in the other direction is one extra
   * read-only query per fire; the cost of this direction is an item that waits for an unrelated
   * approval to come along, which is the same shape as the quiet-source-account bug that stranded 19
   * translatable items in `WatchTick` for 21 hours.
   *
   * No agent turn: formatting is mechanical (canonical text per channel, minus bold on the channels
   * that cannot render it), so this stage costs a subprocess and a query, not a subscription turn.
   *
   * Warnings do not fail the tick — see `TickReport.notes` for where they go instead and why.
   */
  private async format(stagesRun: string[]): Promise<TickReport> {
    const result = await this.runStage(FORMAT_STAGE, [ONLY_MISSING_FLAG]);
    stagesRun.push(FORMAT_STAGE);

    if (!result.ok) return this.fail(stagesRun, result);

    if (parseFormatted(result.stdout) === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: FORMAT_STAGE,
        detail: `unrecognised format output: "${result.stdout}"`,
      });
    }

    const notes = parseWarnings(result.stdout);
    return notes.length > 0 ? { ok: true, stagesRun, notes } : { ok: true, stagesRun };
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
