// tests/app/convertTick.test.ts
//
// The sibling of tests/app/watchTick.test.ts, for the conversion tick. Same contract, stage for
// stage: every parsed stdout must be recognised or fail the tick, the `claude -p` turn is spent
// only when there is work, and a cleanly-exited agent that saved nothing is a failure and not a
// success. The comments here name only what differs from `WatchTick`; the reasoning behind the
// shared shape lives in `src/app/WatchTick.ts` and in that file's own test, and is not repeated.
import { describe, it, expect } from "vitest";
import { ConvertTick } from "../../src/app/ConvertTick";
import type { StageResult, WorksheetAgent } from "../../src/ports/WorksheetAgent";
import { formatStatus, pipelineStages } from "../../src/status/pipeline";
import { tickOutcome } from "../../src/cli/tickOutcome";
import { preparedVariantsLine, NOTHING_TO_CONVERT_LINE } from "../../src/cli/convertPrepareLines";

function recordingAgent(onFill?: (kind: string) => void) {
  const calls: string[] = [];
  const paths: string[] = [];
  const agent: WorksheetAgent = {
    async fill(path, kind) {
      calls.push(kind);
      paths.push(path);
      onFill?.(kind);
      return { ok: true, stdout: "saved" };
    },
  };
  return { agent, calls, paths };
}

/**
 * Real `pnpm status` output for a given Converted total, built through `formatStatus`/
 * `pipelineStages` themselves rather than hand-written — the same rule `watchTick.test.ts`'s own
 * `statusStdout` follows, and for the same reason: `ConvertTick` reads that total to prove the
 * agent actually saved what it was given, so a hand-written fixture would let the parser be tested
 * against a shape `pnpm status` no longer prints.
 *
 * The Translated total is deliberately NOT equal to the Converted one anywhere in this file. Both
 * lines sit in the same block, one directly above the other, and a parser that read the wrong one
 * would be invisible if the two fixtures agreed.
 */
function statusStdout(converted: number, translated = 41): string {
  return [
    "database: development · localhost:5432/herald",
    formatStatus(
      pipelineStages({
        collected: 128,
        translations: Array.from({ length: translated }, () => ({ status: "approved" })),
        // Rows, not items: `Converted (variants)`' total is one per (itemId, type), which is also
        // exactly what one `convert:save` adds — see ConvertTick's own comment on why that makes it
        // comparable with the count `convert:prepare` reported.
        variants: Array.from({ length: converted }, (_, i) => ({ itemId: `x:${i}`, status: "converted" })),
        renderings: [],
        published: [],
      }),
    ),
  ].join("\n");
}

const PREPARED_3 = preparedVariantsLine(3, "output/variants/worksheets/batch-X.md");
/** The second line the real CLI prints under the first — see the "--approve" test for why it matters. */
const SAVE_HINT = "Fill each 변환 section, then run: pnpm convert:save --id <id> --type <x|announcement|explainer|casual|kol|pr> --file <ko.txt>";

/**
 * A stage runner over a small model of the real pipeline, plus the agent that drives it. The
 * `status` stage is not a fixed string: it reports a Converted total that grows by `savesPerPass`
 * every time the stub agent is asked to fill a conversion worksheet — which is exactly what a real
 * `convert:save` per variant would do, and is the only thing that distinguishes an agent that did
 * its job from one that exited cleanly having done nothing.
 */
function pipeline(
  opts: {
    prepare?: string;
    /** How many variants the agent actually saves per pass. Defaults to the three the default
     *  `prepare` line hands it — i.e. a fully successful pass. */
    savesPerPass?: number;
    converted?: number;
    /** Make this one stage exit non-zero, the way a real stage does when the database is down. */
    failStage?: string;
  } = {},
) {
  const ran: string[] = [];
  let converted = opts.converted ?? 12;
  const { agent, calls, paths } = recordingAgent((kind) => {
    if (kind === "conversion") converted += opts.savesPerPass ?? 3;
  });

  const run = async (script: string, args: string[]): Promise<StageResult> => {
    ran.push([script, ...args].join(" "));
    if (script === opts.failStage) return { ok: false, stage: script, detail: "ECONNREFUSED" };
    if (script === "convert:prepare") return { ok: true, stdout: opts.prepare ?? PREPARED_3 };
    if (script === "status") return { ok: true, stdout: statusStdout(converted) };
    return { ok: true, stdout: "" };
  };

  return { run, agent, ran, calls, paths };
}

describe("ConvertTick", () => {
  it("prepares, hands the worksheet to the agent, and brackets it with the count that proves the save", async () => {
    const { run, agent, ran, calls, paths } = pipeline();

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["convert:prepare", "status", "status"]);
    expect(calls).toEqual(["conversion"]);
    expect(paths).toEqual(["output/variants/worksheets/batch-X.md"]);
    // The two `status` runs bracket the agent pass — they are the before/after of the saved-something
    // check, not pipeline steps.
    expect(ran).toEqual(["convert:prepare --limit 1", "status", "status"]);
  });

  it("does not spend an agent turn when nothing approved is waiting to convert", async () => {
    // The common case at a 30-minute cadence: 1차 검수 approves in bursts, and most fires have
    // nothing to do. The whole tick must then cost one short subprocess and no `claude -p` call.
    const { run, agent, ran, calls } = pipeline({ prepare: NOTHING_TO_CONVERT_LINE });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(report.stagesRun).toEqual(["convert:prepare"]);
    // No agent pass means nothing to verify: the saved-something check must not spend two extra
    // database reads on a batch nobody was ever asked to convert.
    expect(ran).toEqual(["convert:prepare --limit 1"]);
  });

  it("still treats a zero count as nothing to do even if a worksheet path comes with it", async () => {
    // Defence in depth against a version skew. `convert-prepare.ts` no longer writes a worksheet for
    // an empty batch, but the tick and the CLI are two processes: a deploy checkout carrying an older
    // `convert:prepare` would print the old `prepared 0 variant(s) → …` shape, and calling the agent
    // on an empty worksheet spends a subscription turn converting nothing.
    const { run, agent, ran, calls } = pipeline({
      prepare: preparedVariantsLine(0, "output/variants/worksheets/batch-X.md"),
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(ran).toEqual(["convert:prepare --limit 1"]);
  });

  it("reports the failing stage and runs nothing after it", async () => {
    const { run, agent, ran, calls } = pipeline({ failStage: "convert:prepare" });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "convert:prepare", detail: "ECONNREFUSED" });
    expect(ran).toEqual(["convert:prepare --limit 1"]);
    expect(calls).toEqual([]);
  });

  it("reports a later stage's failure, not just the first one's", async () => {
    // Makes the pass-through of `failure.stage` discriminating: a hardcoded "convert:prepare" would
    // satisfy the test above on its own.
    const { run, agent, calls } = pipeline({ failStage: "status" });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "status", detail: "ECONNREFUSED" });
    // The failure is found by the *before* count, so the agent must never have been called.
    expect(calls).toEqual([]);
    expect(report.stagesRun).toEqual(["convert:prepare", "status"]);
  });

  // --- "unrecognised stage output is a failure, never success" ---------------------------------

  it("fails the tick when convert:prepare prints something it does not recognise", async () => {
    // The rule this whole file exists for: a broken prepare must not read as a scheduler that
    // succeeds forever while doing nothing. `archiveFile`'s own line is the realistic mistake — a
    // stdout that is genuinely from `convert:prepare` and still says nothing about a batch.
    const { run, agent, calls } = pipeline({ prepare: "  archived the previous unsaved batch → output/archive/x" });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("convert:prepare");
    expect(report.failure?.detail).toContain("unrecognised convert:prepare output");
    // Nothing downstream may run on an unknown worksheet path.
    expect(calls).toEqual([]);
    expect(report.stagesRun).toEqual(["convert:prepare"]);
  });

  it("fails the tick when status prints something it does not recognise", async () => {
    // Same rule applied to the stage the saved-something check depends on: a `pnpm status` whose
    // Converted line stopped matching must fail loudly, not quietly disable the check that reads it.
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "convert:prepare") return { ok: true, stdout: PREPARED_3 };
      return { ok: true, stdout: "Pipeline status\n\n  Collected (X + Lark)  128" };
    };

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("status");
    expect(report.failure?.detail).toContain("unrecognised status output");
    expect(calls).toEqual([]);
  });

  it("parses the two shapes convert:prepare actually prints, and only those", async () => {
    // Cross-file pin. The CLI and this tick are separate processes that agree only on a line of
    // text, so both build it from `src/cli/convertPrepareLines.ts` and this asserts the parser
    // accepts what that module emits — rather than retyping the line here, where a rewording in the
    // CLI would fail every scheduled tick while this suite stayed green.
    const withWorksheet = pipeline({ prepare: preparedVariantsLine(3, "/abs/path/batch-Y.md") });
    const withWorksheetReport = await new ConvertTick(withWorksheet.run, withWorksheet.agent).run();
    expect(withWorksheetReport.ok).toBe(true);
    expect(withWorksheet.paths).toEqual(["/abs/path/batch-Y.md"]);

    const empty = pipeline({ prepare: NOTHING_TO_CONVERT_LINE });
    const emptyReport = await new ConvertTick(empty.run, empty.agent).run();
    expect(emptyReport.ok).toBe(true);
    expect(empty.calls).toEqual([]);
  });

  it("still reads convert:prepare's line when pnpm printed its own output above it", async () => {
    // Every stage is spawned as `pnpm <script>` (runStage.ts), and pnpm writes lines like these to
    // *stdout*, ahead of and after the script's own, whenever it does install work. A parser
    // anchored at the start of the whole buffer fails every tick on the first such line.
    const { run, agent, calls } = pipeline({
      prepare: ["Already up to date", "", PREPARED_3, SAVE_HINT, "Done in 463ms using pnpm v11.20.0"].join("\n"),
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["conversion"]);
  });

  // --- a clean-but-idle agent is not a success -------------------------------------------------

  it("fails the tick when the agent exits cleanly without saving anything", async () => {
    // Exit 0, `is_error: false`, empty `permission_denials` — a `StageResult` of `{ ok: true }`,
    // indistinguishable from a real pass — but no `convert:save` ever ran, so the Converted total
    // does not move. Nothing downstream notices on its own: the next `convert:prepare` re-selects
    // the same items and archives the unsaved batch on its way past, so the only visible symptom is
    // a 2차 검수 board that never fills.
    const { run, agent, calls } = pipeline({ savesPerPass: 0 });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("claude-agent:conversion");
    expect(report.failure?.detail).toContain("saved 0 of the 3 variant(s)");
    // The agent was genuinely invoked — this is not the "never got there" case.
    expect(calls).toEqual(["conversion"]);
    expect(report.stagesRun).toEqual(["convert:prepare", "status", "status"]);
  });

  it("fails the tick when the agent saves only part of the batch", async () => {
    // Halfway is still a failure: the variants it skipped are exactly as invisible as a batch it
    // skipped entirely, and the tick reporting success is what makes them invisible.
    const { run, agent } = pipeline({ savesPerPass: 2 });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.detail).toContain("saved 2 of the 3 variant(s)");
  });

  it("passes when the Converted total grows by the whole prepared batch", async () => {
    // The discriminating half: with the same wiring and a full save, the tick must succeed — a
    // check that failed unconditionally would satisfy the two tests above on its own.
    const { run, agent, calls } = pipeline({ savesPerPass: 3 });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["conversion"]);
  });

  it("reads the Converted total and not the Translated one", async () => {
    // The two lines sit one above the other in `pnpm status`' own output. A parser that matched the
    // wrong one would pass every test above if the fixtures happened to agree, so here the Translated
    // total is frozen while only the Converted one moves: reading Translated makes the delta 0 and
    // fails the tick.
    let converted = 12;
    const run = async (script: string): Promise<StageResult> => {
      if (script === "convert:prepare") return { ok: true, stdout: PREPARED_3 };
      return { ok: true, stdout: statusStdout(converted, 41) };
    };
    const { agent } = recordingAgent(() => {
      converted += 3;
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.failure).toBeUndefined();
  });

  it("does not fail a full save just because a backlog keeps convert:prepare's own count up", async () => {
    // Why the check reads `pnpm status` rather than re-running `convert:prepare` and asking whether
    // its count dropped: `PrepareConversions` selects the first `--limit` of every approved item, so
    // a backlog larger than the limit leaves that count identical before and after a perfect pass.
    // The Converted total has no such ambiguity — `convert:prepare` only ever hands over
    // (itemId, type) pairs with no variant row at all (`listConvertedKeys`), so each save moves it
    // by exactly one regardless of how much backlog is left behind.
    const { run, agent } = pipeline({ prepare: preparedVariantsLine(6, "w.md"), savesPerPass: 6 });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
  });

  // --- the batch size dial ---------------------------------------------------------------------

  it("hands the configured batch size to convert:prepare", async () => {
    const { run, agent, ran } = pipeline({ prepare: preparedVariantsLine(4, "w.md"), savesPerPass: 4 });

    const report = await new ConvertTick(run, agent, { batch: 4 }).run();

    expect(report.ok).toBe(true);
    expect(ran).toContain("convert:prepare --limit 4");
  });

  it("defaults to one item per tick when no batch size is configured", async () => {
    // A hand-run `pnpm convert:tick` with nothing in the environment must keep the behaviour the
    // scheduler is armed with, not acquire a different one — and it must never inherit
    // `PrepareConversions`' own DEFAULT_LIMIT of 20, which at up to six types per item is a
    // 120-variant worksheet inside a single 10-minute `claude -p` call.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent, {}).run();

    expect(ran).toContain("convert:prepare --limit 1");
  });

  // --- the boundaries this tick must never cross -----------------------------------------------

  it("stops at converted: it runs no formatting, publishing or sending stage", async () => {
    // The tick's whole reason for existing is to have 2차 검수 already populated. Sending is what
    // 2차 검수 decides, so nothing here may reach X, Telegram, Typefully or Drive. Asserted over the
    // full list of stages actually run rather than as a comment, because "add the format step too,
    // it is right there" is the most likely next edit to this file.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent).run();

    for (const forbidden of ["format", "send:", "drive:publish", "translate:save", "x:reconcile"]) {
      expect(ran.join(" "), forbidden).not.toContain(forbidden);
    }
  });

  it("never passes --approve to any stage, nor lets the save hint reach the worksheet path", async () => {
    // Real `convert-prepare.ts` prints a second line naming `convert:save`'s flags. The mock has to
    // include it: the value actually derived from stdout is the worksheet path handed to the agent,
    // and a regex that swallowed the hint line would put that whole line into the path while the
    // hardcoded argument arrays stayed clean.
    const { run, agent, ran, paths } = pipeline({ prepare: [PREPARED_3, SAVE_HINT].join("\n") });

    await new ConvertTick(run, agent).run();

    expect(ran.length).toBeGreaterThan(1); // guard: a no-op tick would pass vacuously
    expect(ran.join(" ")).not.toContain("--approve");
    expect(paths).toEqual(["output/variants/worksheets/batch-X.md"]);
  });

  it("calls convert:prepare with a limit and nothing else, ever", async () => {
    // `--types` would silently narrow what the scheduler ever produces (an item converted for only
    // some of its types looks converted on the board), and `--ids` would pin the tick to one item
    // forever. Both are what a future "make it configurable too" change reaches for first.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent, { batch: 2 }).run();

    expect(ran.filter((r) => r.startsWith("convert:prepare"))).toEqual(["convert:prepare --limit 2"]);
  });

  it("keeps a failure short enough for the Telegram alert to still name the stage", async () => {
    // `tickOutcome` composes `${stage}: ${detail}` and condenses it, and
    // deploy/herald-notify-failure.sh then keeps only the last 500 characters of the journal line.
    // The saved-something failure is the one this tick will actually produce, so it is the one
    // checked end to end.
    const { run, agent } = pipeline({ savesPerPass: 0 });

    const report = await new ConvertTick(run, agent).run();
    const { line, exitCode } = tickOutcome("convert", report);

    expect(exitCode).toBe(1);
    expect(line).not.toContain("\n");
    expect(line.slice(-500)).toContain("convert: FAILED — claude-agent:conversion:");
    expect(line).toContain("(ran convert:prepare → status → status)");
  });
});
