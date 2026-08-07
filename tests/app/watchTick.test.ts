// tests/app/watchTick.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WatchTick } from "../../src/app/WatchTick";
import type { StageResult, WorksheetAgent } from "../../src/ports/WorksheetAgent";
import { formatStatus, pipelineStages } from "../../src/status/pipeline";
import { watchOutcome } from "../../src/cli/watchSummary";

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
 * Real `pnpm status` output for a given Translated total, built through `formatStatus`/
 * `pipelineStages` themselves rather than hand-written. `WatchTick` reads that total to prove the
 * agent actually saved what it was given, so the fixture has to stay tied to the real formatter:
 * hand-writing the line would let the two drift, and the parser would then be tested against a
 * shape `pnpm status` no longer prints. `database:` first, because `status.ts` prints that line
 * before the funnel.
 */
function statusStdout(translated: number): string {
  return [
    "database: development · localhost:5432/herald",
    formatStatus(
      pipelineStages({
        collected: 128,
        translations: Array.from({ length: translated }, () => ({ status: "translated" })),
        variants: [],
        renderings: [],
        published: 0,
      }),
    ),
  ].join("\n");
}

const COLLECTED_2 = "collected 2 threads (5 tweets) for @x — covered a ~ b";
const COLLECTED_2_WITH_GAP =
  "collected 2 threads (5 tweets) for @x — covered 2026-08-06T00:00:00.000Z ~ 2026-08-06T02:00:00.000Z" +
  ", GAP (open) ~ 2026-08-06T00:00:00.000Z (limit reached)";
// The longest a GAP notice's tail ever gets: `gap.to` is always a real ISO timestamp, and
// `gap.from` — "(open)" in the fixture above — is only shorter than one when the watermark had
// never been set at all. A months-old outage's actual boundaries, not shortened for the test.
const COLLECTED_2_WITH_REALISTIC_GAP =
  "collected 2 threads (5 tweets) for @Mantle_Official — covered 2026-08-04T12:00:00.000Z ~ 2026-08-06T02:00:00.000Z" +
  ", GAP 2026-08-04T12:00:00.000Z ~ 2026-08-06T00:00:00.000Z (limit reached)";
const PREPARED_2 = "prepared 2 item(s) → output/translations/worksheets/batch-X.md";
const ALIGNED_2 = "aligned 2 · skipped 0 (no precedent) → output/translations/worksheets/align-X.md";
const NOTHING_TO_ALIGN = "nothing to align · skipped 0 (no precedent)";

/**
 * A stage runner over a small model of the real pipeline, plus the agent that drives it. The
 * `status` stage is not a fixed string: it reports a Translated total that grows by `savesPerPass`
 * every time the stub agent is asked to fill a *translation* worksheet — which is exactly what a
 * real `translate:save` per item would do, and is the only thing that distinguishes an agent that
 * did its job from one that exited cleanly having done nothing.
 */
function pipeline(
  opts: {
    collect?: string;
    prepare?: string;
    align?: string;
    /** How many items the agent actually saves per translation pass. Defaults to the two the
     *  default `prepare` line hands it — i.e. a fully successful pass. */
    savesPerPass?: number;
    translated?: number;
    /** Make this one stage exit non-zero, the way a real stage does when the database is down. */
    failStage?: string;
  } = {},
) {
  const ran: string[] = [];
  let translated = opts.translated ?? 40;
  const { agent, calls, paths } = recordingAgent((kind) => {
    if (kind === "translation") translated += opts.savesPerPass ?? 2;
  });

  const run = async (script: string, args: string[]): Promise<StageResult> => {
    ran.push([script, ...args].join(" "));
    if (script === opts.failStage) return { ok: false, stage: script, detail: "ECONNREFUSED" };
    if (script === "collect") return { ok: true, stdout: opts.collect ?? COLLECTED_2 };
    if (script === "translate:prepare") return { ok: true, stdout: opts.prepare ?? PREPARED_2 };
    if (script === "status") return { ok: true, stdout: statusStdout(translated) };
    return { ok: true, stdout: opts.align ?? ALIGNED_2 };
  };

  return { run, agent, ran, calls, paths };
}

describe("WatchTick", () => {
  it("still runs the translate stages when nothing new was collected, without calling the agent", async () => {
    // This test used to assert `ran === ["collect"]`, encoding an early return whose comment
    // claimed "zero new threads: nothing downstream has work to do". That claim is false: the
    // collect queue and the translate queue are independent. Measured 2026-08-07 against
    // production — @Mantle_Official went quiet for 21 hours, every tick stopped after collect, and
    // 19 items sat translatable and untranslated the whole time. The backlog could only ever drain
    // while the source account was *also* posting, which is precisely backwards.
    //
    // What the early return was protecting is the `claude -p` subscription turn, and that is
    // already guarded twice below, per stage: `prepared.count > 0` and `aligned !== null`. So the
    // assertion worth keeping is this one — the agent is still never called.
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      if (script === "collect") return { ok: true, stdout: "collected 0 threads (0 tweets) for @x — nothing new in window" };
      if (script === "translate:prepare") return { ok: true, stdout: "prepared 0 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: NOTHING_TO_ALIGN };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(ran).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(calls).toEqual([]);
  });

  it("drains the translate backlog on a tick that collected nothing — the bug this fixes", async () => {
    // The regression itself. Nothing new arrived, but items are waiting to be translated, so the
    // agent must be handed the worksheet. Before the fix this returned after collect and the
    // backlog never moved.
    const { run, agent, ran, calls } = pipeline({
      collect: "collected 0 threads (0 tweets) for @x — nothing new in window",
      prepare: PREPARED_2,
      align: NOTHING_TO_ALIGN,
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["translation"]);
    expect(ran).toContain("translate:prepare --limit 3");
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
    const { run, agent, ran, calls } = pipeline();

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status", "translate:align"]);
    expect(calls).toEqual(["translation", "alignment"]);
    // The two `status` runs bracket the translation pass — they are the before/after of the
    // saved-something check, not pipeline steps.
    expect(ran).toEqual(["collect", "translate:prepare --limit 3", "status", "status", "translate:align --limit 3"]);
  });

  it("passes the configured cutoff to translate:prepare, so a tick translates recent items first", async () => {
    // Without this, `PrepareTranslations` slices the first `--limit` of the *whole* untranslated
    // backlog, oldest first. Measured against production on 2026-08-06: 211 untranslated items
    // reaching back to 2026-06-01, so the 23 threads the same tick had just collected would not
    // have been translated for ~6 days — the one thing this scheduler exists to do.
    const { run, agent, ran } = pipeline();

    const report = await new WatchTick(run, agent, { translateSince: "2026-07-27T14:35:24.000Z" }).run();

    expect(report.ok).toBe(true);
    expect(ran).toContain("translate:prepare --limit 3 --since 2026-07-27T14:35:24.000Z");
  });

  it("leaves the cutoff off translate:align, which selects by precedent and not by date", async () => {
    // `translate:align` operates on items that are already translated — i.e. already past the
    // cutoff by construction. Passing it a `--since` it has no flag for would make every tick
    // fail at the align stage.
    const { run, agent, ran } = pipeline();

    await new WatchTick(run, agent, { translateSince: "2026-07-27T14:35:24.000Z" }).run();

    expect(ran).toContain("translate:align --limit 3");
    expect(ran.some((r) => r.startsWith("translate:align") && r.includes("--since"))).toBe(false);
  });

  it("omits --since entirely when no cutoff is configured", async () => {
    // The whole-backlog behaviour has to stay reachable: a hand-run `pnpm watch` with no
    // HERALD_TRANSLATE_SINCE in the environment must not silently acquire a cutoff.
    const { run, agent, ran } = pipeline();

    await new WatchTick(run, agent, {}).run();

    expect(ran).toContain("translate:prepare --limit 3");
    expect(ran.some((r) => r.includes("--since"))).toBe(false);
  });

  it("translates but skips alignment when there is no precedent", async () => {
    const { run, agent, calls } = pipeline({ collect: "collected 1 threads (2 tweets) for @x — covered a ~ b", align: "nothing to align · skipped 1 (no precedent)" });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status", "translate:align"]);
    // Not `[]` — the translation pass must still have run. Asserting only the
    // absence of "alignment" would also pass if the tick did nothing at all.
    expect(calls).toEqual(["translation"]);
  });

  it("skips the translation pass when the batch prepared nothing", async () => {
    const { run, agent, ran, calls } = pipeline({
      prepare: "prepared 0 item(s) → output/translations/worksheets/batch-X.md",
      align: NOTHING_TO_ALIGN,
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(calls).toEqual([]);
    // No agent pass means nothing to verify: the saved-something check must not spend two extra
    // database reads per tick on a batch nobody was ever asked to translate.
    expect(ran).not.toContain("status");
  });

  it("never passes --approve to any stage", async () => {
    // Real `translate-prepare.ts` prints this exact second line, containing "--approve" in
    // running text. The mock must include it — a stdout with no "--approve" substring anywhere
    // can only catch a hardcoded literal in the implementation, not the realistic bug: a parse
    // that forwards a stdout *line* into an argument list.
    const prepareStdout = [
      "prepared 2 item(s) → output/translations/worksheets/batch-X.md",
      "Translate each item's 원문 into the 번역 section, then run: pnpm translate:save --id <id> --file <korean.txt> [--approve]",
    ].join("\n");
    const { run, agent, ran, paths } = pipeline({ prepare: prepareStdout, align: NOTHING_TO_ALIGN });

    await new WatchTick(run, agent).run();

    expect(ran.length).toBeGreaterThan(1); // guard: a no-op tick would pass vacuously
    // Cheap guard against a hardcoded literal — `ran` is built entirely from hardcoded argument
    // arrays ([] and ["--limit","3"]), so it can never contain "--approve" no matter how badly
    // the stdout parse breaks. It is not the assertion that matters.
    expect(ran.join(" ")).not.toContain("--approve");
    // The value that *is* derived from stdout is the worksheet path handed to the agent. A regex
    // that swallowed the hint line (e.g. matching the whole buffer instead of one line) would put
    // "--approve" into this path even though `ran` stays clean — this is the assertion that
    // actually exercises the trap.
    expect(paths).toEqual(["output/translations/worksheets/batch-X.md"]);
  });

  it("still skips alignment when 'nothing to align' carries the tm:promote hint suffix", async () => {
    // Real `translate-align.ts:36` appends this suffix whenever `skipped > 0`. This is the
    // branch `NOTHING_TO_ALIGN_LINE` is deliberately not end-anchored for.
    const { run, agent, calls } = pipeline({
      align: "nothing to align · skipped 1 (no precedent) — run `pnpm tm:promote` to add precedent pairs",
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status", "translate:align"]);
    expect(calls).toEqual(["translation"]);
  });

  // Task 1's "reports the failing stage" test only ever exercised `collect`, so it couldn't
  // distinguish a genuine pass-through of `failure.stage` from a hardcoded "collect". This test
  // fails a later stage instead, to make that assertion discriminating.
  it("reports a later stage's failure, not just collect's", async () => {
    const { run, agent, ran, calls } = pipeline({ failStage: "translate:align" });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure).toEqual({ stage: "translate:align", detail: "ECONNREFUSED" });
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status", "translate:align"]);
    expect(ran).toEqual(["collect", "translate:prepare --limit 3", "status", "status", "translate:align --limit 3"]);
    expect(calls).toEqual(["translation"]);
  });

  // --- "unrecognised stage output is a failure, never success" -------------------------------
  //
  // Three separate guards, one per parsed stage, and all three were deletable with the whole
  // suite staying green. The rule they enforce is the one at the top of WatchTick.ts: a broken
  // collector (or an unparseable prepare/align) must not read as a scheduler that succeeds
  // forever while doing nothing. The ledger recorded this as scoped to prepare/align "(collect
  // has it)" — collect did not have it either.

  it("fails the tick when collect prints something it does not recognise", async () => {
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      // A `collect` that exits 0 having printed a warning instead of its own summary line: the
      // count is unknown, and "unknown" must never be read as the "0 new threads" early exit.
      return { ok: true, stdout: "twitterapi.io returned 200 with an empty body; nothing parsed" };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("collect");
    expect(report.failure?.detail).toContain("unrecognised collect output");
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });

  it("fails the tick when translate:prepare prints something it does not recognise", async () => {
    const { agent, calls } = recordingAgent();
    const run = async (script: string): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: COLLECTED_2 };
      if (script === "translate:prepare") return { ok: true, stdout: "  archived the previous unsaved batch → output/archive/x" };
      return { ok: true, stdout: NOTHING_TO_ALIGN };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("translate:prepare");
    expect(report.failure?.detail).toContain("unrecognised translate:prepare output");
    // Nothing downstream may run on an unknown worksheet path.
    expect(calls).toEqual([]);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare"]);
  });

  it("fails the tick when translate:align prints something it does not recognise", async () => {
    const { run, agent, calls } = pipeline({ align: "TypeError: Cannot read properties of undefined" });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("translate:align");
    expect(report.failure?.detail).toContain("unrecognised translate:align output");
    // The translation pass still ran and still counts — only the alignment pass is refused.
    expect(calls).toEqual(["translation"]);
  });

  it("fails the tick when status prints something it does not recognise", async () => {
    // Same rule as the three above, applied to the stage the saved-something check depends on: a
    // `pnpm status` whose Translated line stopped matching must fail loudly, not quietly disable
    // the check that reads it.
    const run = async (script: string, args: string[]): Promise<StageResult> => {
      if (script === "collect") return { ok: true, stdout: COLLECTED_2 };
      if (script === "translate:prepare") return { ok: true, stdout: PREPARED_2 };
      if (script === "status") return { ok: true, stdout: "Pipeline status\n\n  Collected (X + Lark)  128" };
      return { ok: true, stdout: NOTHING_TO_ALIGN };
    };
    const { agent, calls } = recordingAgent();

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("status");
    expect(report.failure?.detail).toContain("unrecognised status output");
    expect(calls).toEqual([]);
  });

  // --- a clean-but-idle agent is not a success ------------------------------------------------

  it("fails the tick when the agent exits cleanly without saving anything", async () => {
    // The exact shape of the defect: exit 0, `is_error: false`, empty `permission_denials` — a
    // `StageResult` of `{ ok: true }`, indistinguishable from a real pass — but no
    // `translate:save` ever ran, so the Translated total does not move. Nothing downstream ever
    // notices on its own: `collect` gates the next tick on *new* threads, so these items are not
    // retried until unrelated content arrives, and the next `translate:prepare` archives the
    // unsaved batch on its way past.
    const { run, agent, calls } = pipeline({ savesPerPass: 0, align: NOTHING_TO_ALIGN });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("claude-agent:translation");
    expect(report.failure?.detail).toContain("saved 0 of the 2 item(s)");
    // The agent was genuinely invoked — this is not the "never got there" case.
    expect(calls).toEqual(["translation"]);
    // A failed tick stops: alignment must not run on top of an unsaved batch.
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status"]);
  });

  it("fails the tick when the agent saves only part of the batch", async () => {
    // Halfway is still a failure: the items it skipped are exactly as invisible as a batch it
    // skipped entirely, and the tick reporting success is what makes them invisible.
    const { run, agent } = pipeline({ savesPerPass: 1, align: NOTHING_TO_ALIGN });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.detail).toContain("saved 1 of the 2 item(s)");
  });

  it("passes when the Translated total grows by the whole prepared batch", async () => {
    // The discriminating half: with the same wiring and a full save, the tick must succeed — a
    // check that failed unconditionally would satisfy the two tests above on its own.
    const { run, agent, calls } = pipeline({ savesPerPass: 2, align: NOTHING_TO_ALIGN });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["translation"]);
  });

  it("does not fail a full save just because a backlog keeps translate:prepare's own count up", async () => {
    // Why the check reads `pnpm status` rather than re-running `translate:prepare --limit 3` and
    // asking whether its count dropped: `PrepareTranslations` selects the first `--limit` of
    // *every* untranslated item, so a backlog larger than the limit (the design's own "a burst of
    // ten posts drains over several ticks") leaves that count at 3 both before and after a
    // perfect pass. The Translated total has no such ambiguity — it moves by exactly one per
    // saved item regardless of how much backlog is left behind it.
    const { run, agent } = pipeline({
      prepare: "prepared 3 item(s) → output/translations/worksheets/batch-X.md",
      savesPerPass: 3,
      align: NOTHING_TO_ALIGN,
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
  });

  // --- pnpm's own stdout comes first ----------------------------------------------------------

  it("still reads collect's line when pnpm printed its own output above it", async () => {
    // Every stage is spawned as `pnpm <script>` (runStage.ts), and pnpm writes lines like these to
    // *stdout*, ahead of the script's own, whenever it does install work — verified on this
    // machine. `collect` was the only parser anchored at the start of the whole buffer, so a
    // single leading line made every tick fail at collect, before anything else ever ran.
    const { run, agent, calls } = pipeline({
      collect: ["Already up to date", "", COLLECTED_2, "Done in 463ms using pnpm v11.20.0"].join("\n"),
      align: NOTHING_TO_ALIGN,
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(report.stagesRun).toEqual(["collect", "translate:prepare", "status", "status", "translate:align"]);
    expect(calls).toEqual(["translation"]);
  });

  it("still reads collect's zero-threads line when pnpm printed its own output above it", async () => {
    // The point of this one is parsing, not control flow: leading pnpm noise must not make the
    // zero-threads line unrecognisable and fail the tick. It keeps its value now that a zero
    // collect no longer ends the tick — an unrecognised collect line still fails it, so "ok" here
    // is what proves the line was read.
    const { agent, calls } = recordingAgent();
    const ran: string[] = [];
    const run = async (script: string): Promise<StageResult> => {
      ran.push(script);
      if (script === "collect") {
        return {
          ok: true,
          stdout: ["Already up to date", "collected 0 threads (0 tweets) for @x — nothing new in window"].join("\n"),
        };
      }
      if (script === "translate:prepare") return { ok: true, stdout: "prepared 0 item(s) → output/translations/worksheets/batch-X.md" };
      return { ok: true, stdout: NOTHING_TO_ALIGN };
    };

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(ran).toEqual(["collect", "translate:prepare", "translate:align"]);
    expect(calls).toEqual([]);
  });

  // --- the batch size dial -----------------------------------------------------------------

  it("hands the configured batch size to both translate stages", async () => {
    const { run, agent, ran } = pipeline({
      prepare: "prepared 5 item(s) → output/translations/worksheets/batch-X.md",
      savesPerPass: 5,
      align: NOTHING_TO_ALIGN,
    });

    const report = await new WatchTick(run, agent, { batch: 5 }).run();

    expect(report.ok).toBe(true);
    expect(ran).toContain("translate:prepare --limit 5");
    expect(ran).toContain("translate:align --limit 5");
  });

  it("defaults both translate stages to 3 when no batch size is configured", async () => {
    // A hand-run `pnpm watch` with nothing in the environment must keep the behaviour the
    // scheduler was armed with, not acquire a different one.
    const { run, agent, ran } = pipeline({ align: NOTHING_TO_ALIGN });

    await new WatchTick(run, agent, {}).run();

    expect(ran).toContain("translate:prepare --limit 3");
    expect(ran).toContain("translate:align --limit 3");
  });

  it("keeps the batch size and the cutoff independent on translate:prepare", async () => {
    // Both options land on the same argument list, so a wiring mistake that dropped one while
    // keeping the other would still pass the two tests above.
    const { run, agent, ran } = pipeline({
      prepare: "prepared 5 item(s) → output/translations/worksheets/batch-X.md",
      savesPerPass: 5,
      align: NOTHING_TO_ALIGN,
    });

    await new WatchTick(run, agent, { batch: 5, translateSince: "2026-07-27T14:35:24.000Z" }).run();

    expect(ran).toContain("translate:prepare --limit 5 --since 2026-07-27T14:35:24.000Z");
  });

  // --- a coverage GAP is permanent tweet loss, not a warning ----------------------------------
  //
  // `fetchAuthoredTweets` pages newest-first and stops at MAX_PAGES=50
  // (src/adapters/twitterapi/TwitterApiSourceGateway.ts:36,8,57), and
  // `CollectAuthoredContent` advances the watermark to the newest fetched tweet whether or not it
  // truncated (:74-79). Newest-first plus a page cap means the tweets left behind are the *older*
  // ones, and the next tick's floor is already past them. `computeCoverage` records the hole and
  // `collect.ts:41` prints it — and until now WatchTick's own header said the gap notice was
  // "free text we don't need to parse".

  it("fails the tick when collect reports a GAP, before any translation runs", async () => {
    const { run, agent, ran, calls } = pipeline({ collect: COLLECTED_2_WITH_GAP });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("collect");
    expect(report.stagesRun).toEqual(["collect"]);
    expect(ran).toEqual(["collect"]);
    expect(calls).toEqual([]);
  });

  it("says what was lost and where the backfill procedure is, because this message becomes a Telegram alert", async () => {
    // herald-notify-failure.sh forwards a journal excerpt. An alert saying only "collect failed"
    // costs someone an ssh session to discover what to do. It deliberately does NOT inline a
    // command: the working backfill needs a raised page cap *and* the scheduler's own environment
    // (prod.env + HERALD_OUTPUT_DIR), and a command carrying only the first half writes the
    // recovered threads to the local Docker database while production keeps the hole — which is
    // exactly the confident-looking non-recovery this whole failure path exists to prevent. So the
    // alert carries the loss and a pointer to the one place that has all of it.
    const { run, agent } = pipeline({ collect: COLLECTED_2_WITH_GAP });

    const report = await new WatchTick(run, agent).run();

    expect(report.failure?.detail).toContain("GAP");
    expect(report.failure?.detail).toContain("2026-08-06T00:00:00.000Z");
    expect(report.failure?.detail).toContain("docs/ko/team-runbook.md");
    // Not a bare filename: the runbook is long, and §4's GAP subsection is where the procedure is.
    expect(report.failure?.detail).toContain("수집에 구멍이 생겼을 때");
  });

  it("points the alert's runbook anchor at a heading that still exists", () => {
    // WatchTick.ts embeds the Korean anchor above as literal text so an operator can grep
    // docs/ko/team-runbook.md for the GAP recovery section. Extracted from the source file here,
    // rather than retyped, so a renamed runbook heading fails this test instead of leaving the
    // Telegram alert pointing at a section that no longer exists — the same guard
    // tests/deploy/watchCutoff.test.ts keeps for HERALD_TRANSLATE_SINCE's sibling cross-file value.
    const source = readFileSync(resolve(__dirname, "../../src/app/WatchTick.ts"), "utf8");
    const anchor = /team-runbook\.md §4 "([^"]+)"/.exec(source)?.[1];
    expect(anchor).toBeDefined();

    const runbook = readFileSync(resolve(__dirname, "../../docs/ko/team-runbook.md"), "utf8");
    expect(runbook).toContain(anchor!);
  });

  it("keeps the alert intact through watchOutcome's 300-char budget, even at the GAP text's longest", async () => {
    // `watchSummary.ts`'s `watchOutcome` is what actually reaches Telegram — it composes
    // `${stage}: ${detail}` and runs *that* through `condense()`, which truncates from the tail
    // and marks the cut with `…` (src/shared/text/condense.ts) — but only THEN appends
    // ` (ran ${stages})` on top (src/cli/watchSummary.ts:34). So a truncated `line` never ends
    // with "…" — the marker, if `condense` ever inserts one, always lands mid-string, before that
    // suffix. `.not.toContain("…")` pins this against `condense`'s actual truncation marker
    // wherever it falls; an `endsWith` check here would be vacuously true regardless of whether
    // anything was cut. The clause most worth losing to a silent truncation — that a later green
    // tick is *not* proof of a fix, the single most misleading fact about this failure mode — is
    // also asserted by name, not just "nothing was cut". Measured at 261 of 300 characters for
    // this fixture (see the budget comment in `WatchTick`'s gap branch).
    const { run, agent } = pipeline({ collect: COLLECTED_2_WITH_REALISTIC_GAP });

    const report = await new WatchTick(run, agent).run();
    const { line } = watchOutcome(report);

    expect(line).not.toContain("…");
    expect(line).toContain("GAP 2026-08-04T12:00:00.000Z ~ 2026-08-06T00:00:00.000Z");
    expect(line).toContain("docs/ko/team-runbook.md");
    expect(line).toContain("not proof of a fix");
  });

  it("runs the tick normally when collect's line carries no GAP", async () => {
    // The discriminating half: a gap check that fired unconditionally would satisfy both tests
    // above while breaking every tick.
    const { run, agent, calls } = pipeline({ align: NOTHING_TO_ALIGN });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(true);
    expect(calls).toEqual(["translation"]);
  });

  it("still reads a GAP when pnpm printed its own lines around collect's", async () => {
    // Same trap the `m`-flag comment on COLLECT_LINE was added for: `pnpm <script>` writes
    // "Already up to date" / "Done in 463ms" to stdout around the script's own output.
    const { run, agent } = pipeline({
      collect: ["Already up to date", "", COLLECTED_2_WITH_GAP, "Done in 463ms using pnpm v11.20.0"].join("\n"),
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("collect");
  });

  it("fails on a GAP even when the same line reports zero threads — the check order is defence-in-depth", async () => {
    // `computeCoverage` cannot produce this shape today: it only ever sets `gap` alongside a
    // non-zero kept count (`if (tweets.length === 0) return { ..., gap: null }`,
    // src/domain/coverage.ts). So nothing currently exercises this fixture through the real
    // pipeline — which is exactly why this is pinned directly rather than left to whatever
    // `computeCoverage` happens to guarantee.
    //
    // The `threadCount === 0` early return this comment used to warn about is gone (a quiet
    // collect no longer ends the tick — see WatchTick.run()), so a zero-thread GAP would now fall
    // through to the translate stages instead of returning `{ ok: true }`. Still worth pinning,
    // and now for a sharper reason: permanent tweet loss must fail the tick *before* anything
    // downstream runs, and a tick that keeps working past a GAP looks healthier than one that
    // stops — which is the direction a future edit is most likely to drift.
    const { run, agent, calls } = pipeline({
      collect: "collected 0 threads (0 tweets) for @x — nothing new in window, GAP (open) ~ 2026-08-06T00:00:00.000Z (limit reached)",
    });

    const report = await new WatchTick(run, agent).run();

    expect(report.ok).toBe(false);
    expect(report.failure?.stage).toBe("collect");
    expect(calls).toEqual([]);
  });

  it("calls collect with no arguments, ever", async () => {
    // Two distinct losses if this changes. `--since` puts CollectAuthoredContent into adhoc mode
    // (src/app/CollectAuthoredContent.ts:32, and the `if (!adhoc)` at :74), which skips the
    // watermark advance: the watermark freezes, the same window is re-collected every tick, and
    // the zero-threads gate that keeps the agent from being called for nothing never fires again.
    // `--limit` makes `applyThreadLimit` drop threads while the watermark still advances past
    // them — permanent, silent loss. Both are what a future "make collect configurable too"
    // change reaches for first.
    const { run, agent, ran } = pipeline({ align: NOTHING_TO_ALIGN });

    await new WatchTick(run, agent, { batch: 5, translateSince: "2026-07-27T14:35:24.000Z" }).run();

    expect(ran.filter((r) => r.startsWith("collect"))).toEqual(["collect"]);
  });
});
