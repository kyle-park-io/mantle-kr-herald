import { agentStage, type StageResult, type StageRunner, type WorksheetAgent } from "../ports/WorksheetAgent";
import type { TickReport } from "./TickReport";
import { DEFAULT_WATCH_BATCH } from "../cli/watchBatch";

// Declared in ./TickReport since `ConvertTick` reports the same shape and `src/cli/tickOutcome.ts`
// formats both. Re-exported here because this is where every existing caller imports it from, and a
// type's import path is not worth churning across the suite to make a point about where it lives.
export type { TickReport };

const COLLECT_STAGE = "collect";
const PREPARE_STAGE = "translate:prepare";
const ALIGN_STAGE = "translate:align";
const STATUS_STAGE = "status";

// `src/cli/collect.ts:42` prints exactly one line of this shape:
//   collected 3 threads (7 tweets) for @Mantle_Official — covered 2026-08-05T… ~ 2026-08-05T…
//   collected 0 threads (0 tweets) for @Mantle_Official — nothing new in window
//   collected 2 threads (5 tweets) for @Mantle_Official — covered … ~ …, GAP … ~ … (limit reached)
// The leading count is load-bearing, and — as of this fix — so is the tail after "— ": that is
// where `computeCoverage` (src/domain/coverage.ts) reports a GAP, and a GAP there is *permanent*
// tweet loss, not free text. `fetchAuthoredTweets` pages newest-first and stops at DEFAULT_MAX_PAGES=50
// (src/adapters/twitterapi/TwitterApiSourceGateway.ts:36,8,57); `CollectAuthoredContent` still
// advances the watermark to the newest fetched tweet regardless (:74-79) — holding it back would
// just re-fetch the same 50 pages forever and never progress. Newest-first plus a page cap means
// whatever was left behind is the *older* material, and the next tick's floor is already past it,
// so a GAP here has to fail the tick loudly, not scroll past in a journal nobody reads.
//
// `m`, like every pattern below, and for a reason that is not about `collect` itself: every stage
// here is spawned as `pnpm <script>` (src/adapters/agent/runStage.ts), and pnpm writes its own
// lines — `Already up to date`, `Done in 463ms using pnpm v11.20.0` — to *stdout*, ahead of and
// after the script's own output, whenever it does install work. Without `m` (and with the buffer
// anchored at `^`), one such leading line makes every single tick fail at collect.
const COLLECT_LINE = /^collected (\d+) threads \(\d+ tweets\) for @\S+ — (.+)$/m;

// The exact marker `src/cli/collect.ts:41` writes ahead of a real gap's boundary timestamps, and
// the leading separator that joins it to the coverage window before it. The alert quotes the marker
// from `GAP ` onward — the separator is how the marker is *found*, not part of what it says — so the
// slice below skips exactly the separator's length rather than a literal 2.
const GAP_SEPARATOR = ", ";
const GAP_MARKER = `${GAP_SEPARATOR}GAP `;

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

// `src/status/pipeline.ts`'s `formatStatus` pads the label column to the widest label and the
// count column to the widest count, so both runs of spaces are variable:
//   Pipeline status
//
//     Collected (X + Lark)  128
//     Translated             41   (approved 12)
// Only the Translated total is read here — see `translatedCount` below for what it is for.
const TRANSLATED_LINE = /^\s*Translated\s+(\d+)/m;

/**
 * Returns the thread count `collect` reported, whether its line carries a coverage GAP, and the
 * tail of the line (everything after "— ") that decision was made from — or `undefined` if the
 * stdout doesn't match the known shape at all. Unrecognised stdout must be treated as a failure by
 * the caller — never as "nothing new" — or a broken collector reads as a scheduler that succeeds
 * forever while doing nothing.
 *
 * `tail` is exposed so the caller can pull the GAP's own text (boundary timestamps included) back
 * out of the *matched line* rather than re-scanning the whole stdout buffer with a second, looser
 * pattern: a second `/GAP .+$/m` over the untrimmed buffer would let the first `GAP ` *anywhere*
 * in pnpm's own surrounding noise win, not necessarily collect's.
 */
function parseCollect(stdout: string): { threadCount: number; gap: boolean; tail: string } | undefined {
  const match = COLLECT_LINE.exec(stdout.trim());
  if (!match) return undefined;
  return { threadCount: Number(match[1]), gap: match[2].includes(GAP_MARKER), tail: match[2] };
}

type Prepared = { count: number; worksheetPath: string };

/** Same "unrecognised → undefined, caller must fail" contract as parseCollect. */
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

/** Same "unrecognised → undefined, caller must fail" contract as the parsers above. */
function parseTranslatedCount(stdout: string): number | undefined {
  const match = TRANSLATED_LINE.exec(stdout);
  if (!match) return undefined;
  return Number(match[1]);
}

export type WatchTickOptions = {
  /**
   * Floor handed to `translate:prepare --since`. Omitted means "the whole untranslated backlog",
   * which is what a hand-run `pnpm watch` with no configuration gets. Validated and normalised to
   * a full UTC ISO timestamp by `src/cli/translateSince.ts` before it reaches here — this class
   * does no I/O and reads no environment, so the CLI is where that happens.
   */
  translateSince?: string;

  /**
   * Items handed to each translate stage's `--limit`. Omitted means `DEFAULT_WATCH_BATCH` — the
   * value a hand-run `pnpm watch` with nothing in the environment gets, and the one the scheduler
   * was armed with. Validated and normalised to a positive integer by `parseWatchBatch` in
   * `src/cli/watchBatch.ts` before it reaches here — this class does no I/O and reads no
   * environment, so the CLI is where that happens.
   */
  batch?: number;
};

export class WatchTick {
  private readonly runStage: StageRunner;
  private readonly agent: WorksheetAgent;
  private readonly translateSince?: string;
  private readonly batch: number;

  constructor(run: StageRunner, agent: WorksheetAgent, options: WatchTickOptions = {}) {
    this.runStage = run;
    this.agent = agent;
    this.translateSince = options.translateSince;
    this.batch = options.batch ?? DEFAULT_WATCH_BATCH;
  }

  async run(): Promise<TickReport> {
    const stagesRun: string[] = [];

    const collect = await this.runStage(COLLECT_STAGE, []);
    stagesRun.push(COLLECT_STAGE);

    if (!collect.ok) {
      return this.fail(stagesRun, collect);
    }

    const parsed = parseCollect(collect.stdout);
    if (parsed === undefined) {
      return this.fail(stagesRun, {
        ok: false,
        stage: COLLECT_STAGE,
        detail: `unrecognised collect output: "${collect.stdout}"`,
      });
    }

    // A coverage GAP is permanent tweet loss (see the header comment above `COLLECT_LINE`), so it
    // fails the tick before anything downstream runs. Checked ahead of the zero-threads early
    // return just below on purpose: `computeCoverage` only ever sets a gap alongside a non-zero
    // kept count today, so the ordering is unobservable right now — but if that invariant ever
    // changes, this must still fail loudly rather than fall through to "nothing new".
    if (parsed.gap) {
      // `parsed.tail.includes(GAP_MARKER)` is what made `gap` true, so the marker is guaranteed
      // present here — no fallback needed. Sliced from the tail `COLLECT_LINE` already matched,
      // not re-scanned from the whole stdout buffer, so pnpm's own surrounding noise can never be
      // mistaken for collect's own GAP text (see the header comment above `parseCollect`).
      const gapText = parsed.tail.slice(parsed.tail.indexOf(GAP_MARKER) + GAP_SEPARATOR.length);
      // Why this points at a document instead of inlining a command: recovering the hole takes two
      // corrections at once, and either one alone silently recovers nothing.
      //   1. The cap. `gap.from` is the exact floor the failing run already used
      //      (src/domain/coverage.ts:34), and `fetchAuthoredTweets` always starts from the newest
      //      tweet and pages *down* (TwitterApiSourceGateway.ts), so re-requesting the same floor
      //      re-fetches the same newest ~1000 tweets and hits the same 50-page cap at the same
      //      place. Only HERALD_COLLECT_MAX_PAGES on that one run reaches past it.
      //   2. The environment. `pnpm collect` is `tsx --env-file-if-exists=.env`, so a hand run from
      //      the checkout writes to the repo's .env database (local Docker) and appends to the
      //      repo's own output/x/runs.json — while the hole is in the scheduler's production Neon
      //      and %h/.herald/output. That run looks like a success and leaves a clean ledger row to
      //      "confirm" it, for a recovery that never touched production.
      // The environment setup alone is three lines, which does not fit the budget below, and half
      // the remedy is worse than a pointer to all of it.
      //
      // watchSummary.ts's `watchOutcome` composes `${stage}: ${detail}` (the "collect: " prefix
      // is 9 chars) and runs it through `condense(…, MAX_DETAIL_CHARS = 300)` before it reaches
      // `deploy/herald-notify-failure.sh` and Telegram. `condense` truncates from the *tail*, so
      // this wording is measured, not guessed: with both GAP boundaries as real ISO timestamps
      // (the longest this ever gets — `gap.to` is always a timestamp, `gap.from` is only shorter
      // when it's the "(open)" case), the composed line lands at 261 of 300 chars. That leaves
      // headroom for the one clause that must never be the part that gets cut — the warning that
      // a later green tick is not proof of a fix — to always survive intact.
      return this.fail(stagesRun, {
        ok: false,
        stage: COLLECT_STAGE,
        detail:
          `permanent tweet loss — ${gapText}. Backfill is neither a bare re-run nor a bare pnpm ` +
          `collect: docs/ko/team-runbook.md §4 "수집에 구멍이 생겼을 때". Fires once: a later green ` +
          `tick is not proof of a fix.`,
      });
    }

    // A zero-thread collect does NOT end the tick. It used to, on the claim that "nothing
    // downstream has work to do" — but the collect queue and the translate queue are independent,
    // and that claim cost a measured 21 hours: @Mantle_Official went quiet on 2026-08-06, every
    // tick from 17:17Z on stopped right here, and 19 items sat translatable and untranslated the
    // whole time. The backlog could only drain while the source account was *also* posting, which
    // is exactly backwards — a quiet stretch is when there is finally room to catch up.
    //
    // Nothing is spent by continuing. What that early return was really protecting is the
    // `claude -p` subscription turn, and both turns are already guarded, per stage, by the work
    // they would actually do: `prepared.count > 0` below, and `aligned !== null` after it. A tick
    // with genuinely nothing to do now spends two short subprocesses instead of zero, which at one
    // tick every two hours is not worth a rule that can strand a backlog.

    // `--since` only on prepare, never on align: `translate:align` selects by precedent among
    // items that are *already* translated — everything it can see is past the cutoff by
    // construction — and it has no `--since` flag to receive one anyway.
    const prepareArgs = ["--limit", String(this.batch)];
    if (this.translateSince) prepareArgs.push("--since", this.translateSince);

    const prepare = await this.runStage(PREPARE_STAGE, prepareArgs);
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
      // Bracket the agent pass with the one number that proves it did the job. A clean
      // `claude -p` — exit 0, `is_error: false`, no `permission_denials` — proves the process ran
      // and was never blocked; it does NOT prove the model ever called `translate:save`. A model
      // that reads the worksheet, decides it is done, and stops has exactly the same envelope as
      // one that saved every item, and reading that as success is the "green forever while saving
      // nothing" outcome the denial gate's own comment claims to prevent: that gate covers the
      // *denied* variant, this covers the *never tried* one.
      //
      // Not a re-run of `translate:prepare --limit 3` with a "did the count drop?" rule, which was
      // the first fix considered: `PrepareTranslations` selects the first `--limit` of *every*
      // untranslated item, so with a backlog larger than the limit (the design's own "a burst of
      // ten posts drains over several ticks") the count is 3 before the pass and 3 after it even
      // when all three were saved — that rule fails the tick hardest exactly when the scheduler is
      // working hardest. `pnpm status`'s Translated total has no such ambiguity: `prepare` only
      // ever hands over items with no translation row at all, so each save moves this total by
      // exactly one, and it is a read-only query with no worksheet or `pending.json` side effects.
      const before = await this.translatedCount(stagesRun);
      if (typeof before !== "number") {
        return this.fail(stagesRun, before);
      }

      const translation = await this.agent.fill(prepared.worksheetPath, "translation");
      if (!translation.ok) {
        return this.fail(stagesRun, translation);
      }

      const after = await this.translatedCount(stagesRun);
      if (typeof after !== "number") {
        return this.fail(stagesRun, after);
      }

      // Fails the tick, deliberately, rather than warning: an unsaved batch is invisible
      // downstream — `collect` gates the next tick on *new* threads, so nothing retries these
      // items until unrelated content happens to arrive, and each later `translate:prepare`
      // archives the unsaved batch on its way past (`src/cli/translate-prepare.ts`). A warning in
      // a journal nobody reads is how that stays unnoticed for days.
      if (after - before < prepared.count) {
        return this.fail(stagesRun, {
          ok: false,
          stage: agentStage("translation"),
          detail:
            `claude -p exited cleanly but saved ${after - before} of the ${prepared.count} item(s) it was given ` +
            `(translated count ${before} → ${after})`,
        });
      }
    }

    const align = await this.runStage(ALIGN_STAGE, ["--limit", String(this.batch)]);
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

  /**
   * How many translations exist right now, per `pnpm status` — or the failure to report when that
   * stage either failed outright or printed something this doesn't recognise. Unrecognised stdout
   * is a failure here for the same reason it is for every other stage in this file: a status line
   * that stopped matching would otherwise silently disable the check that depends on it.
   */
  private async translatedCount(stagesRun: string[]): Promise<number | Extract<StageResult, { ok: false }>> {
    const result = await this.runStage(STATUS_STAGE, []);
    stagesRun.push(STATUS_STAGE);

    if (!result.ok) return result;

    const count = parseTranslatedCount(result.stdout);
    if (count === undefined) {
      return { ok: false, stage: STATUS_STAGE, detail: `unrecognised status output: "${result.stdout}"` };
    }
    return count;
  }

  private fail(stagesRun: string[], failure: Extract<StageResult, { ok: false }>): TickReport {
    return { ok: false, stagesRun, failure: { stage: failure.stage, detail: failure.detail } };
  }
}
