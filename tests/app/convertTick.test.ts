// tests/app/convertTick.test.ts
//
// The sibling of tests/app/watchTick.test.ts, for the conversion tick. Same contract, stage for
// stage: every parsed stdout must be recognised or fail the tick, the `claude -p` turn is spent
// only when there is work, and a cleanly-exited agent that saved nothing is a failure and not a
// success. The comments here name only what differs from `WatchTick`; the reasoning behind the
// shared shape lives in `src/app/WatchTick.ts` and in that file's own test, and is not repeated.
import { describe, it, expect } from "vitest";
import { ConvertTick, MAX_VARIANTS_PER_TICK } from "../../src/app/ConvertTick";
import { FormatVariants } from "../../src/app/FormatVariants";
import type { StageResult, WorksheetAgent } from "../../src/ports/WorksheetAgent";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import { renderingKey, type FormattingStore } from "../../src/ports/FormattingStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { Translation } from "../../src/domain/translation/models";
import { formatStatus, pipelineStages } from "../../src/status/pipeline";
import type { TranslateFloorStatus } from "../../src/status/translateFloor";
import { tickOutcome } from "../../src/cli/tickOutcome";
import { preparedVariantsLine, passthroughVariantsLine, NOTHING_TO_CONVERT_LINE } from "../../src/cli/convertPrepareLines";
import {
  ONLY_MISSING_FLAG,
  formattedRenderingsLine,
  formatWarningLine,
  skippedPostedLine,
  NOTHING_TO_FORMAT_LINE,
} from "../../src/cli/formatLines";

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
  // Same floor state `watchTick.test.ts`'s fixture uses, and for the same reason: a scheduled tick
  // runs `pnpm status` from inside a loaded unit that carries a cutoff.
  const floor: TranslateFloorStatus = { kind: "configured", floor: "2026-07-27T14:35:25.000Z" };
  return [
    "database: development · localhost:5432/herald",
    formatStatus(
      pipelineStages(
        {
          collected: 128,
          translations: Array.from({ length: translated }, (_, i) => ({ itemId: `x:t${i}`, status: "approved" })),
          // Rows, not items: `Converted (variants)`' total is one per (itemId, type), which is also
          // exactly what one `convert:save` adds — see ConvertTick's own comment on why that makes it
          // comparable with the count `convert:prepare` reported.
          variants: Array.from({ length: converted }, (_, i) => ({ itemId: `x:${i}`, status: "converted" })),
          renderings: [],
          published: [],
        },
        { floor, total: 128, inScope: 17 },
      ),
      floor,
    ),
  ].join("\n");
}

const PREPARED_3 = preparedVariantsLine(3, "output/variants/worksheets/batch-X.md");
/** The second line the real CLI prints under the first — see the "--approve" test for why it matters. */
const SAVE_HINT = "Fill each 변환 section, then run: pnpm convert:save --id <id> --type <x|announcement|kakao_notice|explainer|casual|kol|pr> --file <ko.txt>";

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
    /** What the `format` stage prints. Defaults to a full pass over the three variants the default
     *  `prepare` line hands over — the realistic shape, since a variant saved this tick has no
     *  rendering yet by construction. The tests that care what formatting actually *did* drive the
     *  real use case instead; see `memoryPipeline`. */
    format?: string;
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
    if (script === "format") return { ok: true, stdout: opts.format ?? formattedRenderingsLine(3) };
    return { ok: true, stdout: "" };
  };

  return { run, agent, ran, calls, paths };
}

/** The one stage every successful tick ends with, spelled as `ran` records it. */
const FORMAT_CALL = `format ${ONLY_MISSING_FLAG}`;

/**
 * The stage every tick starts with, spelled as `ran` records it: the item limit, then the ceiling on
 * the pairs those items fan out to. Written once here so that changing the second bound does not mean
 * editing eight string literals — but NOT used by the test that pins the flag itself, which spells
 * the whole command out, because a helper that encodes the thing under test cannot fail with it.
 */
const prepareCall = (batch: number) => `convert:prepare --limit ${batch} --max-variants ${MAX_VARIANTS_PER_TICK}`;

describe("ConvertTick", () => {
  it("prepares, hands the worksheet to the agent, and brackets it with the count that proves the save", async () => {
    const { run, agent, ran, calls, paths } = pipeline();

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["convert:prepare", "status", "status", "format"]);
    expect(calls).toEqual(["conversion"]);
    expect(paths).toEqual(["output/variants/worksheets/batch-X.md"]);
    // The two `status` runs bracket the agent pass — they are the before/after of the saved-something
    // check, not pipeline steps. `format` is a pipeline step, and the last one: it is what turns the
    // variants the agent just saved into the cards 2차 검수 reads.
    expect(ran).toEqual([prepareCall(1), "status", "status", FORMAT_CALL]);
  });

  it("bounds the pairs one claude -p call is handed, not only the items", async () => {
    // 2026-08-17, the failure this flag answers: `--limit 1` selected one item, that item had all
    // seven types unconverted, and the single agent call needed an estimated twelve minutes against
    // `ClaudeCodeAgent`'s ten-minute cap. It saved five, was killed mid-sixth, and the tick exited
    // non-zero — one Telegram alert per full-fat item. The item limit could not prevent it; it was
    // already at its floor. So the tick states both bounds, and the second one is the one sized
    // against the cap.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent).run();

    expect(ran[0]).toBe(`convert:prepare --limit 1 --max-variants ${MAX_VARIANTS_PER_TICK}`);
  });

  it("does not spend an agent turn when nothing approved is waiting to convert", async () => {
    // The common case at a 30-minute cadence: 1차 검수 approves in bursts, and most fires have
    // nothing to do. The whole tick must then cost two short subprocesses and no `claude -p` call.
    const { run, agent, ran, calls } = pipeline({ prepare: NOTHING_TO_CONVERT_LINE, format: NOTHING_TO_FORMAT_LINE });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(report.stagesRun).toEqual(["convert:prepare", "format"]);
    // No agent pass means nothing to verify: the saved-something check must not spend two extra
    // database reads on a batch nobody was ever asked to convert. `format` still runs — see
    // "formats even when this tick prepared nothing" below for why that is not the same decision.
    expect(ran).toEqual([prepareCall(1), FORMAT_CALL]);
  });

  it("does not spend an agent turn on a fire whose only work was the x passthrough", async () => {
    // `x` is written straight from the approved translation (`PrepareConversions`), so a fire with
    // nothing but `x` left prints the passthrough line under a `prepared 0` — no worksheet, nothing
    // for the agent. The tick parses stdout with line-anchored regexes, so this pins that the extra
    // line cannot be read as work: calling `claude -p` here would spend a subscription turn on an
    // empty worksheet, and failing the tick on an unrecognised line would page the operator nightly.
    const { run, agent, ran, calls } = pipeline({
      prepare: [NOTHING_TO_CONVERT_LINE, passthroughVariantsLine(2)].join("\n"),
      format: NOTHING_TO_FORMAT_LINE,
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(ran).toEqual([prepareCall(1), FORMAT_CALL]);
  });

  it("still treats a zero count as nothing to do even if a worksheet path comes with it", async () => {
    // Defence in depth against a version skew. `convert-prepare.ts` no longer writes a worksheet for
    // an empty batch, but the tick and the CLI are two processes: a deploy checkout carrying an older
    // `convert:prepare` would print the old `prepared 0 variant(s) → …` shape, and calling the agent
    // on an empty worksheet spends a subscription turn converting nothing.
    const { run, agent, ran, calls } = pipeline({
      prepare: preparedVariantsLine(0, "output/variants/worksheets/batch-X.md"),
      format: NOTHING_TO_FORMAT_LINE,
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(ran).toEqual([prepareCall(1), FORMAT_CALL]);
  });

  it("reports the failing stage and runs nothing after it", async () => {
    const { run, agent, ran, calls } = pipeline({ failStage: "convert:prepare" });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "convert:prepare", detail: "ECONNREFUSED" });
    expect(ran).toEqual([prepareCall(1)]);
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
      if (script === "format") return { ok: true, stdout: formattedRenderingsLine(3) };
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
    expect(ran).toContain(prepareCall(4));
  });

  it("defaults to one item per tick when no batch size is configured", async () => {
    // A hand-run `pnpm convert:tick` with nothing in the environment must keep the behaviour the
    // scheduler is armed with, not acquire a different one — and it must never inherit
    // `PrepareConversions`' own DEFAULT_LIMIT of 20, which at up to seven types per item is a
    // 140-variant worksheet inside a single 10-minute `claude -p` call.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent, {}).run();

    expect(ran).toContain(prepareCall(1));
  });

  // --- the boundaries this tick must never cross -----------------------------------------------

  it("stops at rendered: it runs no publishing or sending stage", async () => {
    // The tick's whole reason for existing is to have 2차 검수 already populated. Sending is what
    // 2차 검수 decides, so nothing here may reach X, Telegram, Typefully or Drive. Asserted over the
    // full list of stages actually run rather than as a comment.
    //
    // `format` was on this list until the tick grew a format stage of its own, and taking it off is
    // not a relaxation of the boundary — a rendering is not a delivery. `SendChannels` sends only
    // `approved` renderings and only when a human asks it to; everything this tick writes is
    // `status: "rendered"`, which is precisely the state 2차 검수 exists to act on. What replaced the
    // ban is the far narrower rule below: format runs, in one mode, with no other flag.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent).run();

    for (const forbidden of ["send:", "drive:publish", "translate:save", "x:reconcile", "--approve"]) {
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

  it("calls convert:prepare with the two bounds and nothing else, ever", async () => {
    // `--types` would silently narrow what the scheduler ever produces (an item converted for only
    // some of its types looks converted on the board), and `--ids` would pin the tick to one item
    // forever. Both are what a future "make it configurable too" change reaches for first.
    //
    // `--max-variants` is on this command and is not one of those: it defers pairs to the next fire
    // instead of excluding them, because a pair with no variant row is offered again by the very
    // next `convert:prepare`. That difference is the whole reason it is allowed here, so it is
    // asserted as part of the expected command rather than tolerated by a looser matcher.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent, { batch: 2 }).run();

    expect(ran.filter((r) => r.startsWith("convert:prepare"))).toEqual([prepareCall(2)]);
  });

  it("calls format with the only-missing flag and nothing else, ever", async () => {
    // The flag IS the invariant. A bare `pnpm format` rebuilds every rendering there is, from the
    // variant, at `status: "rendered"` — which discards the text a reviewer edited in 2차 검수 and
    // resets their approval. Wired into a 30-minute tick, dropping this one argument erases the
    // board's accumulated review work 48 times a day, silently. `--ids`/`--types`/`--channels` are
    // what a "make it configurable too" change reaches for next, and each of them would narrow what
    // the scheduler ever renders while still looking like it ran.
    const { run, agent, ran } = pipeline();

    await new ConvertTick(run, agent, { batch: 2 }).run();

    expect(ran.filter((r) => r.startsWith("format"))).toEqual([FORMAT_CALL]);
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

// --- the format stage ---------------------------------------------------------------------------
//
// Why these tests drive the real `FormatVariants` instead of a canned stdout like every other stage
// in this file: the rule the format stage has to hold — it must never touch a rendering that already
// exists — is a property of the use case, and no string fixture can observe it. A tick that ran
// `pnpm format` with no flag at all would satisfy every parser test above and still discard 2차 검수's
// accumulated work on its first fire.

const NOW = "2026-08-08T04:17:00.000Z";

function contentVariant(over: Partial<ContentVariant> = {}): ContentVariant {
  return {
    itemId: "x:1", type: "x", sourceKorean: "승인된 번역", convertedText: "변환된 카피",
    status: "converted", createdAt: "2026-08-01T00:00:00.000Z", ...over,
  };
}

/**
 * A tick whose `format` stage is the actual use case over in-memory stores, driven by the argv the
 * tick really passes and printing the lines `src/cli/format.ts` really prints (both built from
 * `src/cli/formatLines.ts`, so a rewording on either side cannot pass here and fail in production).
 *
 * The agent stub does what a real `claude -p` pass does through `convert:save`: it upserts variants.
 * `status` is then computed from the store rather than canned, so the tick's own saved-something
 * check is satisfied by the same rows the format stage later reads — the two stages agree because
 * they share a database, exactly as they do in production.
 */
function memoryPipeline(opts: {
  variants: ContentVariant[];
  renderings: ChannelRendering[];
  saves?: ContentVariant[];
  /**
   * The 1차 rows the format stage now consults, so a `posted` one can be observed to stop a card
   * being built. Defaults to none — a variant with no translation row formats exactly as before,
   * which keeps every case above this one about the stage it is actually testing.
   */
  translations?: Translation[];
}) {
  const { variants, renderings } = opts;
  const saves = opts.saves ?? [];
  const translations = opts.translations ?? [];

  const conversionStore: ConversionStore = {
    loadAll: async () => [...variants],
    upsert: async (v) => {
      const i = variants.findIndex((x) => x.itemId === v.itemId && x.type === v.type);
      if (i >= 0) variants[i] = v;
      else variants.push(v);
    },
    listConvertedKeys: async () => new Set(variants.map((v) => `${v.itemId}:${v.type}`)),
  };
  const formattingStore: FormattingStore = {
    loadAll: async () => [...renderings],
    upsert: async (r) => {
      const i = renderings.findIndex((x) => renderingKey(x) === renderingKey(r));
      if (i >= 0) renderings[i] = r;
      else renderings.push(r);
    },
    listRenderedKeys: async () => new Set(renderings.map(renderingKey)),
  };
  const translationStore: TranslationStore = {
    loadAll: async () => [...translations],
    upsert: async () => {},
    listTranslatedIds: async () => new Set(translations.map((t) => t.itemId)),
  };

  const ran: string[] = [];
  const agent: WorksheetAgent = {
    async fill() {
      for (const v of saves) await conversionStore.upsert(v);
      return { ok: true, stdout: "saved" };
    },
  };

  const run = async (script: string, args: string[]): Promise<StageResult> => {
    ran.push([script, ...args].join(" "));
    if (script === "convert:prepare") {
      return {
        ok: true,
        stdout: saves.length > 0 ? preparedVariantsLine(saves.length, "w.md") : NOTHING_TO_CONVERT_LINE,
      };
    }
    if (script === "status") return { ok: true, stdout: statusStdout(variants.length) };
    if (script === "format") {
      const { renderings: made, warnings, skippedPosted } = await new FormatVariants(
        conversionStore,
        formattingStore,
        translationStore,
        () => NOW,
      ).run({}, { onlyMissing: args.includes(ONLY_MISSING_FLAG) });
      // Composed exactly as `src/cli/format.ts` composes it, skipped line included — the point of
      // this helper is that a rewording on either side cannot pass here and fail in production.
      const first = made.length > 0 ? formattedRenderingsLine(made.length) : NOTHING_TO_FORMAT_LINE;
      const skipped = skippedPosted.length > 0 ? [skippedPostedLine(skippedPosted.length)] : [];
      return { ok: true, stdout: [first, ...skipped, ...warnings.map(formatWarningLine)].join("\n") };
    }
    return { ok: true, stdout: "" };
  };

  return { run, agent, ran };
}

describe("ConvertTick — the format stage", () => {
  it("never touches a rendering that already exists: an approved one survives a full tick byte-identical", async () => {
    // THE invariant. `FormatVariants` builds every rendering it emits at `status: "rendered"`,
    // `refined: false`, with canonical text straight from the variant, and upserts it — so a format
    // run that selects a pair a reviewer has already approved *overwrites the approval and the
    // reviewer's edit*, with no trace and no confirmation. Production is holding approved renderings
    // right now, and this tick fires every 30 minutes.
    //
    // The variant is deliberately still present and its `convertedText` deliberately differs from
    // the stored rendering: that is the state a reviewer leaves behind after editing on the board,
    // and it is the only state in which the overwrite is observable at all.
    const approved: ChannelRendering = {
      itemId: "x:1", type: "x", channel: "x",
      text: "검수자가 2차 검수에서 직접 고쳐 둔 문구",
      refined: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "approved",
      approvedAt: "2026-08-02T03:04:05.678Z",
    };
    const untouched = structuredClone(approved);
    const renderings = [approved];
    const variants = [contentVariant({ itemId: "x:1", convertedText: "검수자가 고치기 전의 변환본" })];

    const { run, agent } = memoryPipeline({
      variants,
      renderings,
      saves: [contentVariant({ itemId: "x:2", convertedText: "이번 tick이 새로 변환한 글" })],
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    const after = renderings.find((r) => r.itemId === "x:1")!;
    expect(after).toEqual(untouched);
    // Spelled out as well as compared whole, so a failure names which half moved.
    expect(after.text).toBe(untouched.text);
    expect(after.status).toBe("approved");
    expect(after.approvedAt).toBe("2026-08-02T03:04:05.678Z");
    expect(after.refined).toBe(true);
    expect(after.createdAt).toBe("2026-08-01T00:00:00.000Z");

    // The discriminating half: a format stage that skipped everything — or was never wired at all —
    // would satisfy every assertion above. The variant this tick converted must have become a card.
    expect(renderings.filter((r) => r.itemId === "x:2").map((r) => r.channel)).toEqual(["x"]);
    expect(renderings.find((r) => r.itemId === "x:2")!.status).toBe("rendered");
  });

  it("renders every card of everything the tick just converted, not only the first", async () => {
    // One piece of news becomes two 공지 variants since the split — `announcement` for telegram and
    // `kakao_notice` for kakao — so "the board is populated" is not one card per tick. A format
    // stage that stopped after the first variant would leave the 카카오 card missing and look like
    // it worked. (Before the split this was one `announcement` fanning out to both channels; the
    // pair of cards the tick has to produce is the same, the axis it walks to get there is not.)
    const renderings: ChannelRendering[] = [];
    const { run, agent } = memoryPipeline({
      variants: [],
      renderings,
      saves: [
        contentVariant({ itemId: "x:9", type: "announcement", convertedText: "📢 **공지** 본문" }),
        contentVariant({ itemId: "x:9", type: "kakao_notice", convertedText: "📢 공지 본문" }),
      ],
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(renderings.map((r) => r.channel)).toEqual(["telegram", "kakao"]);
  });

  it("formats even when this tick prepared nothing", async () => {
    // The stranded-backlog case, and the reason the format stage sits outside the "nothing was
    // prepared" early return. A variant can exist with no rendering for reasons this tick had no
    // part in: an earlier tick that failed at its own format stage, a hand-run `pnpm convert:save`,
    // a rendering deleted during a migration. If formatting only ever ran on a tick that itself
    // converted something, such an item would wait for an unrelated approval to come along — the
    // same shape of bug that once left 19 translatable items stranded for 21 hours because a quiet
    // source account ended `WatchTick` before its translate stages.
    //
    // What the early return protects is the `claude -p` subscription turn, and this stage spends
    // none: it is mechanical, it is one query when there is nothing to do, and the agent is not
    // involved.
    const renderings: ChannelRendering[] = [];
    const { run, agent, ran } = memoryPipeline({
      variants: [contentVariant({ itemId: "x:7", convertedText: "지난 tick이 저장하고 렌더링은 못 한 변환본" })],
      renderings,
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(ran).toEqual([prepareCall(1), FORMAT_CALL]);
    expect(renderings.map((r) => r.itemId)).toEqual(["x:7"]);
  });

  it("does nothing at all when every variant already has its rendering", async () => {
    // The steady state at this cadence, and the one the zero-work output shape exists for: the
    // stage must report "nothing" in a shape the tick recognises, not fail and not silently rewrite
    // the rows it just decided to leave alone.
    const existing: ChannelRendering = {
      itemId: "x:1", type: "x", channel: "x", text: "이미 렌더링된 문구",
      refined: false, createdAt: "2026-08-01T00:00:00.000Z", status: "rendered",
    };
    const renderings = [existing];
    const { run, agent } = memoryPipeline({ variants: [contentVariant({ itemId: "x:1" })], renderings });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(renderings).toEqual([structuredClone(existing)]);
  });

  it("does not manufacture cards for an item that already went out, and does not fail over saying so", async () => {
    // The bug this stage shipped with. `--only-missing` asks "which (item, type, channel) pairs have
    // no rendering?" and a retired item's pairs answer "all of them" forever, so the tick rebuilt
    // channel cards for finished work every 30 minutes — and a human deleting those cards got them
    // back on the next fire, because the variants are still there. Three items were in this state in
    // production on 2026-08-08.
    //
    // The second half of the name is the contract with `src/cli/formatLines.ts`: the stage now
    // prints a `skipped n item(s)` line under its summary. It must not fail the parse (the summary
    // line is still the first line and still matches), and it must not arrive as a tick note either
    // — this is the permanent steady state for every retired item, not a warning anyone can act on.
    const renderings: ChannelRendering[] = [];
    const { run, agent } = memoryPipeline({
      variants: [contentVariant({ itemId: "x:2080608995371597892" })],
      renderings,
      translations: [{
        itemId: "x:2080608995371597892", source: "x", sourceText: "source", koreanText: "한국어",
        status: "posted", translatedAt: "2026-08-01T00:00:00.000Z", postedUrl: "https://x.com/0xMantleKR/status/1",
      }],
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(renderings).toEqual([]);
    expect(report.notes).toBeUndefined();
  });

  it("carries FormatVariants' warnings out of the tick instead of swallowing them", async () => {
    // `runStage` captures a stage's stdout and the tick throws it away on success, so an over-length
    // emission would be reported to nobody: the reviewer sees the card but not that it is 2 weighted
    // characters over X's limit until they open the destination breakdown. They travel as report
    // notes, which `tickOutcome` prints ahead of the outcome line — see its own comment for why they
    // are notes and not a failure.
    const renderings: ChannelRendering[] = [];
    const { run, agent } = memoryPipeline({
      variants: [],
      renderings,
      saves: [contentVariant({ itemId: "x:5", type: "x", convertedText: "가".repeat(141) })],
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.notes).toEqual(["  ⚠ x:5/x/x: x_paste, x_typefully: 282/280 (2 초과)"]);
    // End to end: the note reaches the journal, and the outcome line stays the last line so the
    // failure hook's `journalctl -n 5` tail keeps working.
    const { notes, line } = tickOutcome("convert", report);
    expect(notes).toEqual(report.notes);
    expect(line).toContain("convert: ok");
  });

  it("fails the tick when format prints something it does not recognise", async () => {
    // Same contract as every other parser here: unrecognised is a failure, never "nothing to do". A
    // format stage whose line stopped matching is a board that stops filling, which looks exactly
    // like a quiet week.
    const { agent } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "convert:prepare") return { ok: true, stdout: NOTHING_TO_CONVERT_LINE };
      return { ok: true, stdout: "  ⚠ x:1/x/x: 282/280 (2 초과)" };
    };

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("format");
    expect(report.failure?.detail).toContain("unrecognised format output");
  });

  it("reports a failing format stage", async () => {
    const { run, agent } = pipeline({ failStage: "format" });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "format", detail: "ECONNREFUSED" });
    expect(report.stagesRun).toEqual(["convert:prepare", "status", "status", "format"]);
  });

  it("does not run format after a failure earlier in the tick", async () => {
    // A tick that already failed must not go on writing rows. The agent failure is the realistic
    // one: its batch is half-saved at best, and formatting a half-saved batch produces cards a
    // reviewer would then be reading against nothing.
    const { run, agent, ran } = pipeline({ savesPerPass: 0 });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(ran).not.toContain(FORMAT_CALL);
  });

  it("still reads format's line when pnpm printed its own output around it", async () => {
    // Every stage is spawned as `pnpm <script>`, and pnpm writes `Already up to date` /
    // `Done in 463ms …` to stdout around the script's own lines whenever it does install work.
    const { run, agent } = pipeline({
      format: ["Already up to date", "", formattedRenderingsLine(3), "Done in 463ms using pnpm v11.20.0"].join("\n"),
    });

    const report = await new ConvertTick(run, agent).run();

    expect(report.ok).toBe(true);
  });

  it("parses the two shapes pnpm format actually prints, and only those", async () => {
    // Cross-file pin, the same one `convertPrepareLines` gets above: the CLI and the tick are two
    // processes that agree on nothing but this text, so both build it from
    // `src/cli/formatLines.ts` and this asserts the parser accepts what that module emits.
    for (const stdout of [formattedRenderingsLine(7), NOTHING_TO_FORMAT_LINE]) {
      const { run, agent } = pipeline({ format: stdout });
      const report = await new ConvertTick(run, agent).run();
      expect(report.ok, stdout).toBe(true);
    }
  });
});
