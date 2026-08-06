# Watch Tick Tunables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the watch tick's batch size configuration, turn the timer/timeout coupling into a test, and fail the tick when `collect` reports a coverage GAP — the silent tweet-loss path a configurable batch size would otherwise widen.

**Architecture:** Three small, separable changes to an existing feature. A pure `HERALD_WATCH_BATCH` parser beside `src/cli/translateSince.ts`, threaded through `WatchTick` as an option to replace two `--limit 3` literals. A new deploy-file test that derives the fire period from `OnCalendar=` and bounds `TimeoutStartSec` against it. And an extension to `WatchTick`'s collect parser that reads the `, GAP ` marker `src/cli/collect.ts:41` already prints and fails the tick on it. No use-case or adapter behaviour changes.

**Tech Stack:** TypeScript (Node 24, ESM, `tsx`), vitest, systemd `--user` units.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-06-watch-tick-tunables-design.md`:

- **`src/app/CollectAuthoredContent.ts` is not modified.** Every collect caller shares its watermark logic and its current behaviour is correct — holding the watermark back on a truncated run re-fetches the same 50 pages forever. The tick learns to notice the consequence; the use case does not change.
- **`MAX_PAGES` stays at 50** in `src/adapters/twitterapi/TwitterApiSourceGateway.ts`.
- **The `(limit reached)` wording in `src/cli/collect.ts:41` and `src/cli/collect-reference.ts:34` stays.** Making it name the real cause means recording that cause in `CollectionRun`, which is the use-case change ruled out above.
- **No `-x H` lookback is added anywhere.** `--since` puts collect into adhoc mode, which skips the watermark advance.
- **The interval value itself does not change.** `OnCalendar=*-*-* 0/2:17:00` stays; this work only makes changing it safe.
- **One batch knob for both translate stages, not two.** They are 3 and 3 today with no evidence they need to diverge.
- **Code, comments, commit messages, and CHANGELOG in English.** `docs/ko/` is Korean.
- Verification commands: `pnpm test` (vitest run) and `pnpm typecheck` (tsc --noEmit). There is no lint script.
- Commit after every task. Never `git add -A` — this working tree is shared with other sessions; stage only the files the task names.

---

### Task 1: `HERALD_WATCH_BATCH` parser and its documentation

The variable and its validation, with nothing consuming it yet. Modelled directly on `src/cli/translateSince.ts` — read that file first; it is the pattern this one follows, including the doc comment that explains *why* the value is configuration rather than a constant.

**Files:**
- Create: `src/cli/watchBatch.ts`
- Create: `tests/cli/watchBatch.test.ts`
- Modify: `.env.example` (§1, beside `HERALD_TRANSLATE_SINCE` at line 133, and the variable table at lines 42-43)

**Interfaces:**
- Consumes: nothing.
- Produces: `parseWatchBatch(raw: string | undefined): number` and `DEFAULT_WATCH_BATCH: number` (= 3), both exported from `src/cli/watchBatch.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/watchBatch.test.ts`:

```ts
// tests/cli/watchBatch.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWatchBatch, DEFAULT_WATCH_BATCH } from "../../src/cli/watchBatch";

describe("parseWatchBatch", () => {
  it("defaults to 3 when the variable is unset", () => {
    expect(DEFAULT_WATCH_BATCH).toBe(3);
    expect(parseWatchBatch(undefined)).toBe(3);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `HERALD_WATCH_BATCH=` with nothing after it reaches Node as "", not undefined — the same
    // trap `parseTranslateSince` documents. `Number("")` is 0, which would hand `--limit 0` to
    // every tick: a scheduler that prepares nothing, forever, while looking configured.
    expect(parseWatchBatch("")).toBe(3);
    expect(parseWatchBatch("   ")).toBe(3);
  });

  it("accepts a positive integer, trimmed", () => {
    expect(parseWatchBatch("5")).toBe(5);
    expect(parseWatchBatch(" 10 ")).toBe(10);
  });

  it("refuses zero", () => {
    expect(() => parseWatchBatch("0")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses a negative", () => {
    expect(() => parseWatchBatch("-3")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses a fraction instead of silently flooring it", () => {
    // `--limit 2.5` arriving at translate:prepare is a much worse thing to debug than a refusal
    // at the entry point, where the journal line names the variable.
    expect(() => parseWatchBatch("2.5")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses values `Number()` would happily coerce", () => {
    // `Number("0x10")` is 16 and `Number("1e2")` is 100. A unit-file typo must not quietly become
    // a batch size nobody chose, so the check is a digit pattern and not `Number.isFinite`.
    for (const raw of ["three", "3 items", "0x10", "1e2", "Infinity", "+3"]) {
      expect(() => parseWatchBatch(raw), raw).toThrow(/HERALD_WATCH_BATCH/);
    }
  });

  it("names the offending value, so the journal line is actionable on its own", () => {
    // This message reaches Telegram through herald-notify-failure.sh's journal excerpt. "invalid
    // batch size" without the value sends someone to ssh into the box to find out what it was.
    expect(() => parseWatchBatch("zero")).toThrow(/"zero"/);
  });
});

describe("HERALD_WATCH_BATCH documentation", () => {
  it("is listed in .env.example, where every read variable is listed", () => {
    // Same guard `tests/deploy/watchCutoff.test.ts` makes for HERALD_TRANSLATE_SINCE: a variable
    // documented nowhere is a variable the next operator does not know exists, and a doc table
    // with no test rots at the first rename.
    const example = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    expect(example).toMatch(/^HERALD_WATCH_BATCH=/m);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm test tests/cli/watchBatch.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/watchBatch`.

- [ ] **Step 3: Write `src/cli/watchBatch.ts`**

Invariants, not a snippet — write it yourself against these:

- Exports `DEFAULT_WATCH_BATCH = 3` and `parseWatchBatch(raw: string | undefined): number`.
- Trim first. Empty after trimming (including `undefined`) returns `DEFAULT_WATCH_BATCH`.
- Accept **only** `/^\d+$/` after trimming, then require the parsed number `> 0`. This is what refuses `2.5`, `-3`, `0x10`, `1e2`, `+3`, and `Infinity` in one rule; a `Number.isFinite` + `Number.isInteger` pair does not.
- The thrown message must contain the literal string `HERALD_WATCH_BATCH` and the raw value via `JSON.stringify(raw)`, and say what is acceptable — mirror the wording shape of `parseTranslateSince`'s throw.
- Carry a doc comment in the style of `src/cli/translateSince.ts`: why this is configuration rather than a constant (it is the tick's throughput dial — `batch × 24/interval_hours` items per day — and it is tuned on a different clock than the code changes on), and why `""` is treated as unset.
- No I/O, no `process.env` read. The CLI reads the environment; this validates a value.

- [ ] **Step 4: Add the variable to `.env.example`**

Two places, both required by the test above and by the file's own conventions — read the file's §1 around lines 110-135 first to match the comment style:

- The variable table near lines 42-43: a `HERALD_WATCH_BATCH (§1)` row, marked exactly like the `HERALD_OUTPUT_DIR (§1)` and `HERALD_TRANSLATE_SINCE (§1)` rows beside it (`·  ·  ·` with the trailing note that only `pnpm watch`'s systemd unit sets it).
- §1 itself, immediately after the `HERALD_TRANSLATE_SINCE=` block near line 133: a commented block then a bare `HERALD_WATCH_BATCH=` line. The comment states the default (3), that it applies to both `translate:prepare` and `translate:align`, that it is only set by `pnpm watch`'s systemd unit, and that raising it does **not** require raising `TimeoutStartSec` — `claude -p` is called once per worksheet, not once per item, so a bigger batch is still at most two agent calls.

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm test tests/cli/watchBatch.test.ts && pnpm typecheck`
Expected: PASS, and `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/watchBatch.ts tests/cli/watchBatch.test.ts .env.example
git commit -m "feat(watch): validate HERALD_WATCH_BATCH before a tick can use it"
```

---

### Task 2: Thread the batch size through the tick

**Files:**
- Modify: `src/app/WatchTick.ts` (the `WatchTickOptions` type at :92-100, the constructor at :107-111, `["--limit", "3"]` at :140, and `["--limit", "3"]` at :210)
- Modify: `src/cli/watch.ts` (add the `parseWatchBatch` call beside the `parseTranslateSince` call at :16, pass it into the `WatchTick` construction at :31)
- Modify: `tests/app/watchTick.test.ts`
- Modify: `deploy/herald-watch.service` (comment only)

**Interfaces:**
- Consumes: `parseWatchBatch`, `DEFAULT_WATCH_BATCH` from `src/cli/watchBatch.ts` (Task 1).
- Produces: `WatchTickOptions` gains `batch?: number`. `WatchTick` keeps its `(run, agent, options)` constructor shape, so no other caller changes.

- [ ] **Step 1: Write the failing tests**

Add to `tests/app/watchTick.test.ts`. The `pipeline()` helper at the top of that file already takes `prepare` and `savesPerPass` — read it before writing these, because the saved-something check requires the prepared count and the saves to agree or the tick fails for an unrelated reason:

```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test tests/app/watchTick.test.ts`
Expected: the three new tests FAIL (`--limit 3` is still hardcoded); every pre-existing test in the file still PASSES.

- [ ] **Step 3: Implement**

Invariants:

- `WatchTickOptions` gains `batch?: number`, documented the way `translateSince` is: what an omitted value means, and that validation happened in the CLI because this class does no I/O and reads no environment.
- The constructor stores `options.batch ?? DEFAULT_WATCH_BATCH`. Import the constant from `src/cli/watchBatch.ts` rather than repeating `3` — a default in two places is a default that will disagree with itself.
- Both `--limit` literals are replaced by the stored value. The `--since` push at :141 is untouched and still applies to `prepare` only.
- `src/cli/watch.ts`: call `parseWatchBatch(process.env.HERALD_WATCH_BATCH)` next to the existing `parseTranslateSince` call, **above** the startup line, for the reason its comment already gives — a typo'd value must stop the tick at the entry point where `registerErrorHandler` turns the throw into the non-zero exit `OnFailure=` watches for, not reach a stage as garbage.

- [ ] **Step 4: Document that the timeout does not scale with the batch**

In `deploy/herald-watch.service`, extend the `TimeoutStartSec=1800` comment block: raising `HERALD_WATCH_BATCH` does not require raising this bound, because `ClaudeCodeAgent` is invoked once per *worksheet* and one tick makes at most two such calls regardless of how many items each worksheet holds. The existing 2 × 600s + 600s arithmetic in that comment is unchanged by a bigger batch. Write it as a sentence in that block, not a new block.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS. The pre-existing `--limit 3` assertions at `tests/app/watchTick.test.ts:129`, `:142`, `:153`, `:164`, and `:246` must still pass untouched — they are the regression check that the default did not move.

- [ ] **Step 6: Commit**

```bash
git add src/app/WatchTick.ts src/cli/watch.ts tests/app/watchTick.test.ts deploy/herald-watch.service
git commit -m "feat(watch): one batch-size dial for both translate stages"
```

---

### Task 3: A coverage GAP fails the tick, and the runbook stops recommending the loss path

The tick currently reads collect's thread count and ignores the rest of the line — `src/app/WatchTick.ts:17-18` says so explicitly. That "rest of the line" is where a permanent tweet loss is reported. Read the spec's "What the watermark actually guarantees" section before starting; the failure message you write here is what a human reads in Telegram at 3am.

**Files:**
- Modify: `src/app/WatchTick.ts` (`COLLECT_LINE` at :25, `parseCollectedThreadCount` at :58-62, the collect handling at :116-135)
- Modify: `tests/app/watchTick.test.ts`
- Modify: `docs/ko/team-runbook.md` (§4, after `### 워터마크가 꼬였을 때` which ends at line 419)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing other tasks depend on. `parseCollectedThreadCount` becomes `parseCollect(stdout: string): { threadCount: number; gap: boolean } | undefined`, private to the module.

- [ ] **Step 1: Write the failing tests**

Add to `tests/app/watchTick.test.ts`. Put the fixture beside the existing `COLLECTED_2` constant at :44 — its shape is `src/cli/collect.ts:41`'s template with a real gap:

```ts
const COLLECTED_2_WITH_GAP =
  "collected 2 threads (5 tweets) for @x — covered 2026-08-06T00:00:00.000Z ~ 2026-08-06T02:00:00.000Z" +
  ", GAP (open) ~ 2026-08-06T00:00:00.000Z (limit reached)";
```

and the tests:

```ts
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

  it("says what was lost and how to backfill it, because this message becomes a Telegram alert", async () => {
    // herald-notify-failure.sh forwards a journal excerpt. An alert saying only "collect failed"
    // costs someone an ssh session to discover that the remedy is an adhoc collect — and adhoc is
    // exactly the mode that backfills without disturbing the watermark.
    const { run, agent } = pipeline({ collect: COLLECTED_2_WITH_GAP });

    const report = await new WatchTick(run, agent).run();

    expect(report.failure?.detail).toContain("GAP");
    expect(report.failure?.detail).toContain("2026-08-06T00:00:00.000Z");
    expect(report.failure?.detail).toContain("collect --since");
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
```

- [ ] **Step 2: Run the tests and confirm the right ones fail**

Run: `pnpm test tests/app/watchTick.test.ts`
Expected: the two GAP-failure tests and the pnpm-noise GAP test FAIL. "runs the tick normally", "calls collect with no arguments" and every pre-existing test PASS already — that is expected and correct, they are the guards, not the new behaviour.

- [ ] **Step 3: Implement**

Invariants:

- `COLLECT_LINE` keeps its `^`-anchor and its `m` flag (see its own comment for why both matter) and gains a capture of the rest of the line after `— `. The existing thread-count capture must not move semantically; `parseCollect` returns `{ threadCount, gap }` where `gap` is whether that tail contains the `, GAP ` marker `src/cli/collect.ts:41` writes.
- Unrecognised stdout keeps the existing contract exactly: `undefined` from the parser, and the caller fails with the `unrecognised collect output` detail. The test at `tests/app/watchTick.test.ts:258` pins this.
- The gap check runs **immediately after the parse and before the `threadCount === 0` early return**. A gap implies a non-zero count today (`computeCoverage` only fills `gap` when at least one tweet was kept), so the order is unobservable now — put it first anyway, so that if that invariant ever changes the tick fails loudly rather than returning success.
- The failure uses stage `"collect"` and a detail that contains: the word `GAP`, the gap's own text as collect printed it (so the boundary timestamps are in the alert), the reason (the tick never passes `--limit`, so in a scheduler journal `(limit reached)` can only be the `MAX_PAGES` page cap), and the remedy — a `pnpm collect --since <from>` backfill, which is adhoc and therefore leaves the watermark alone.
- Also state in that detail, or in a comment beside it, that this fires once: the watermark has already advanced past the hole, so the next tick collects a normal window and goes green. That is correct for a one-time event, and a reader of the alert needs to know a green tick afterwards does *not* mean the hole was filled.
- Update the `WatchTick.ts:14-24` header comment. It currently states the gap notice is free text nobody parses. That sentence is now false.

- [ ] **Step 4: Fix the runbook, which currently recommends the loss path**

`docs/ko/team-runbook.md:417-419` ends `### 워터마크가 꼬였을 때` with this recommendation:

> 자동화를 붙일 때는 매시간 `pnpm collect <target> --since 2h`(`--limit` 없이)를 권장합니다 — 2시간 창과 1시간 주기가 1시간 겹쳐서 커버리지가 끊기지 않고, 겹치는 구간은 upsert가 중복 제거합니다.

It predates the watch scheduler and is now wrong in the way the spec spends a whole section on: a scheduled `--since 2h` is an adhoc run, so it freezes the watermark and permanently disables the zero-threads gate at `WatchTick.ts:133`. Replace it (Korean, matching the surrounding **증상/원인/조치/참고** style) with: automation is `pnpm watch` and its systemd timer (§6), which passes collect no arguments on purpose; `--since` and `--limit` remain the hand-run backfill tools precisely *because* they do not move the watermark.

Then add a new subsection after that section, before `### 두 발송을 동시에 돌리면...` at line 421:

`### 수집에 구멍이 생겼을 때 (GAP 알림)` — **증상**: a `herald-watch` failure alert whose detail contains `GAP`. **원인**: one collect reached the 50-page cap (`MAX_PAGES`), which only happens after a long outage; the watermark advanced past the un-fetched older tail anyway, so it will never be collected on its own. **조치**: run `pnpm collect Mantle_Official --since <the GAP's from timestamp>` by hand — adhoc, so it does not disturb the watermark — then confirm the recovered range in `output/x/runs.json`. **참고**: the next scheduled tick goes green regardless, because the watermark already moved; a green tick is not evidence the hole was filled.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/WatchTick.ts tests/app/watchTick.test.ts docs/ko/team-runbook.md
git commit -m "fix(watch): a coverage GAP is permanent loss, so fail the tick on it"
```

---

### Task 4: The timer/timeout coupling becomes a test

`deploy/herald-watch.service`'s header argues that `TimeoutStartSec=1800` must stay well under the timer's 7200s period, because systemd skips an `OnCalendar=` fire that arrives while the unit is still active. `deploy/herald-watch.timer`'s header invites the edit that tests that bound: *"hourly (`*-*-* *:17:00`) is a one-line change"*. Nothing checks the pair. Read `tests/deploy/watchCutoff.test.ts` first — it does exactly this job for the two cutoffs, and this file is its sibling.

**Files:**
- Create: `tests/deploy/watchTiming.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. A deploy-file assertion, like `tests/deploy/watchCutoff.test.ts`.

- [ ] **Step 1: Write the test**

Create `tests/deploy/watchTiming.test.ts`:

```ts
// tests/deploy/watchTiming.test.ts
//
// Two numbers in two files with a constraint between them, and until now the constraint lived only
// in a comment. systemd skips an OnCalendar= fire that comes due while the unit is still active, so
// a TimeoutStartSec= larger than the fire period turns one wedged tick into a scheduler that looks
// armed and has silently stopped — the single failure this whole feature exists to prevent.
//
// herald-watch.timer's own header invites the edit that tests this ("hourly is a one-line change").
// That is exactly why it is a check and not a sentence: the person making that one-line change is
// not going to re-derive the timeout arithmetic first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const timer = readFileSync(resolve(repoRoot, "deploy/herald-watch.timer"), "utf8");
const service = readFileSync(resolve(repoRoot, "deploy/herald-watch.service"), "utf8");

/** The `OnCalendar=` value, ignoring the comment block above it. */
function onCalendar(): string | undefined {
  return /^OnCalendar=(.+)$/m.exec(timer)?.[1]?.trim();
}

/**
 * `TimeoutStartSec=` as a plain count of seconds, or `undefined` if it is not written that way.
 * systemd also accepts "30min" and "1h"; supporting those here would mean a unit-suffix parser
 * whose bugs are invisible, so the one shape the unit actually uses is the one shape this reads —
 * and anything else fails the first test below rather than being silently skipped.
 */
function timeoutStartSec(): number | undefined {
  const raw = /^TimeoutStartSec=(\d+)$/m.exec(service)?.[1];
  return raw === undefined ? undefined : Number(raw);
}

/**
 * Fire period in seconds for the two OnCalendar shapes this timer plausibly uses, and `undefined`
 * for anything else:
 *   `*-*-* 0/2:17:00` → every 2 hours
 *   `*-*-* *:17:00`   → hourly
 * Deliberately narrow. A spec this cannot read means the bound below is unchecked, which is the
 * state this file exists to end — so it reports that rather than guessing.
 */
function periodSeconds(spec: string): number | undefined {
  const everyNHours = /^\*-\*-\* \d+\/(\d+):\d{2}:\d{2}$/.exec(spec);
  if (everyNHours) return Number(everyNHours[1]) * 3600;
  if (/^\*-\*-\* \*:\d{2}:\d{2}$/.test(spec)) return 3600;
  return undefined;
}

describe("watch scheduler timing", () => {
  it("ships both halves of the coupling", () => {
    expect(onCalendar()).toBeDefined();
    // undefined here means TimeoutStartSec= is missing or uses a unit suffix. Either way the bound
    // below cannot be checked, and an unbounded tick holds the unit active across the next fire.
    expect(timeoutStartSec()).toBeDefined();
  });

  it("uses an OnCalendar shape this file can read", () => {
    // If this fails, teach `periodSeconds` the new shape. Do not delete the bound below.
    expect(periodSeconds(onCalendar()!)).toBeDefined();
  });

  it("keeps the tick timeout at or under half the fire period", () => {
    // Half, not all of it: this admits the hourly change the timer's header already sanctions
    // (1800 ≤ 3600/2) while rejecting anything faster, and leaves a full period of slack at the
    // two-hour cadence it ships with.
    expect(timeoutStartSec()!).toBeLessThanOrEqual(periodSeconds(onCalendar()!)! / 2);
  });

  it("reads the shapes it claims to read", () => {
    // Pins the parser against real values. Without this, a `periodSeconds` that returned
    // `undefined` for everything would still satisfy the rejection test below.
    expect(periodSeconds("*-*-* 0/2:17:00")).toBe(7200);
    expect(periodSeconds("*-*-* *:17:00")).toBe(3600);
    expect(periodSeconds("*-*-* 0/6:17:00")).toBe(21600);
  });

  it("refuses shapes it cannot read instead of guessing a period", () => {
    for (const spec of ["Mon *-*-* 17:00:00", "hourly", "*-*-* 0/2:17", "*-*-* 00,30:17:00", ""]) {
      expect(periodSeconds(spec), spec).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test tests/deploy/watchTiming.test.ts`
Expected: all PASS against the units as they ship today — `OnCalendar=*-*-* 0/2:17:00` gives 7200s, and 1800 ≤ 3600. This test documents a constraint that already holds; it is not fixing a violation.

- [ ] **Step 3: Prove the bound actually bites**

A test that has never been seen red is a test nobody has verified. Make two temporary edits together — the hourly `OnCalendar=` alone is not enough, because 1800 ≤ 3600/2 still holds:

1. `deploy/herald-watch.timer`: `OnCalendar=*-*-* *:17:00` (hourly → 3600s period)
2. `deploy/herald-watch.service`: `TimeoutStartSec=2400`

Run: `pnpm test tests/deploy/watchTiming.test.ts`
Expected: "keeps the tick timeout at or under half the fire period" FAILS — 2400 > 1800.

Then revert both and confirm green again:

```bash
git checkout deploy/herald-watch.timer deploy/herald-watch.service
pnpm test tests/deploy/watchTiming.test.ts
```

Note for this step only: these two files are the ones Task 2 also modifies. Run Task 4 after Task 2 has committed, so the `git checkout` above cannot discard Task 2's comment change.

- [ ] **Step 4: Commit**

```bash
git add tests/deploy/watchTiming.test.ts
git commit -m "test(watch): check the timeout against the fire period, not against a comment"
```

---

### Task 5: The startup line records the values this tick ran with

`watchStartupLine` exists so a wrong output root or database is visible in `journalctl --user -u herald-watch` rather than only under `pnpm doctor`. The two values a human can now change belong in the same line.

**Files:**
- Modify: `src/cli/watchStartup.ts` (the signature and the return at :32-35, and the doc comment above it)
- Modify: `src/cli/watch.ts` (the `console.log` at :22)
- Modify: `tests/cli/watchStartup.test.ts` (the four existing call sites at :8, :19, :34, :50-52, plus new tests)

**Interfaces:**
- Consumes: `parseWatchBatch` output and `parseTranslateSince` output, both already computed in `src/cli/watch.ts` by Task 2.
- Produces: `watchStartupLine(outputDir: string, outputOverride: string | undefined, db: DbConfig, tick: { batch: number; translateSince?: string }): string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli/watchStartup.test.ts`:

```ts
  it("names the batch size and the translation floor this tick will use", () => {
    const db: DbConfig = { url: "postgres://u:p@prod-host:5432/herald", env: "production" };

    const line = watchStartupLine("/home/kyle/.herald/output", "/home/kyle/.herald/output", db, {
      batch: 3,
      translateSince: "2026-07-27T14:35:24.000Z",
    });

    expect(line).toContain("batch 3");
    expect(line).toContain("2026-07-27T14:35:24.000Z");
    // The values this line already carried must survive the addition.
    expect(line).toContain("/home/kyle/.herald/output (HERALD_OUTPUT_DIR override)");
    expect(line).toContain("database production");
  });

  it("states an absent translation floor instead of omitting it", () => {
    // A line that simply drops the floor when unset is indistinguishable from one where a cutoff
    // is configured — and "no cutoff" means the tick drains the whole untranslated backlog
    // oldest-first (211 items reaching back to 2026-06-01, measured 2026-08-06). That is the most
    // consequential difference there is between two ticks, so it is stated, not implied.
    const db: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "development" };

    const line = watchStartupLine("/repo/output", undefined, db, { batch: 5, translateSince: undefined });

    expect(line).toContain("batch 5");
    expect(line).toMatch(/translate floor \(none\)/);
  });

  it("distinguishes two ticks that differ only in their batch size", () => {
    // Guards against a line that mentions "batch" in fixed text without interpolating the value.
    const db: DbConfig = { url: "postgres://u:p@localhost:5432/herald", env: "development" };
    const three = watchStartupLine("/repo/output", undefined, db, { batch: 3 });
    const ten = watchStartupLine("/repo/output", undefined, db, { batch: 10 });

    expect(three).not.toEqual(ten);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm test tests/cli/watchStartup.test.ts`
Expected: FAIL — `tsc`/vitest will object to the fourth argument, and the assertions do not hold.

- [ ] **Step 3: Implement**

Invariants:

- The fourth parameter is **required**, not optional. Every caller has both values by the time it logs, and an optional parameter that silently omits the floor is the exact failure the second test above pins.
- The line keeps its existing ` · `-separated shape and its existing first two segments verbatim — `tests/cli/watchStartup.test.ts:9-11, 20-22, 36-41` assert them and must not be edited to accommodate this.
- The floor segment names the value when set and says `(none)` when not. The batch segment interpolates the number.
- `tsc` will point at the four existing call sites in the test file; update each to pass `{ batch: 3 }` (with `translateSince` where the test is about a configured tick). Do not change what those four tests assert.
- Extend the doc comment above the function with why these two joined it: they are the values an operator can change, and a journal that records the outcome of a tick without recording its inputs cannot be read after the fact.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS, `tsc` clean.

- [ ] **Step 5: Verify the real entry point, without running a live tick**

`src/cli/watch.ts` has no test coverage — that is the whole reason `watchStartupLine` was extracted into its own file — so the wiring has to be exercised for real. But **do not run a plain `pnpm watch`.** A full tick calls the live twitterapi.io API, spends a `claude -p` subscription turn, and writes to the local database and the repo's own `output/`. None of that is needed to see one line.

Two runs, both with no side effects. Find the exact invocations yourself by reading `src/cli/watch.ts` and `src/cli/collect.ts`, and confirm from the output that no stage did real work:

1. **The refusal path.** An invalid `HERALD_WATCH_BATCH` must exit non-zero naming the variable and the offending value, and must print **no** startup line — the parse happens before it. This touches nothing.
2. **The line itself.** Make the `collect` stage fail immediately, before it reaches the network or the database, so the real startup line prints and the tick then stops. `src/cli/collect.ts` constructs its `TwitterClient` from `loadConfig()` before it opens a database connection — an absent API key therefore throws in that stage's first statements. Verify from the output that this is what happened, and that no `collected …` line and no agent call appear.

Confirm the startup line names the output root, the database, the batch size, and the translation floor. If either run has a side effect you did not expect, stop and report it rather than continuing.

- [ ] **Step 6: Commit**

```bash
git add src/cli/watchStartup.ts src/cli/watch.ts tests/cli/watchStartup.test.ts
git commit -m "feat(watch): record a tick's inputs in the journal, not just its outcome"
```

---

### Task 6: CHANGELOG, and verify the whole thing

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added` at line 74 and `### Fixed` at line 306)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the full suite and typecheck one more time**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS. Report the actual counts vitest printed — never a number you did not read off the output.

- [ ] **Step 2: Write the CHANGELOG entries**

English, matching the surrounding entries' style — long, specific, and explaining the consequence rather than the diff. Read a few neighbouring bullets under each heading first.

Under `### Added`: `HERALD_WATCH_BATCH` — what it sets (both `translate:prepare` and `translate:align` in a `pnpm watch` tick), its default of 3, that only the systemd unit sets it, that it is validated at the entry point so a typo fails the tick instead of reaching a stage, and that raising it does not require raising `TimeoutStartSec` because `claude -p` runs once per worksheet.

Under `### Fixed`: the GAP failure. State the defect as a user-visible outcome — a collect that hit the 50-page cap advanced the watermark past the tweets it had not fetched, and the tick reported success, so the loss was permanent, unalarmed, and visible only as free text in a journal. Then what changed: the tick now fails on a GAP and the `OnFailure=` hook alerts, with the backfill procedure in the team runbook. Note that the following tick goes green because the watermark already moved, so a green tick does not mean the hole was filled.

Also under `### Fixed`: the runbook's stale recommendation to schedule `pnpm collect --since 2h`, which would have frozen the watermark and disabled the tick's zero-new-threads gate.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): a batch dial, and the loss a green tick was hiding"
```

- [ ] **Step 4: Push and open a PR**

```bash
git push -u origin feat/watch-tick-tunables
gh pr create --title "Watch tick tunables: one batch dial, a checked timeout bound, and a GAP that fails" --body-file -
```

The PR body covers: what changed and why (batch size was two code literals; the timer/timeout coupling was a comment; a coverage GAP was silent permanent loss), what was deliberately **not** changed and why (no `-x H` lookback — `--since` sets adhoc mode and freezes the watermark; `CollectAuthoredContent` untouched; `MAX_PAGES` still 50), and the verification actually run. Link the spec at `docs/superpowers/specs/2026-08-06-watch-tick-tunables-design.md`.

Do not merge. Kyle reviews and merges.

---

## Notes for the implementer

- **This working tree is shared with other sessions.** Run `git status` before starting each task and stage only the files the task names. Never `git add -A`. `git status` is blind to `output/` — if a step writes there, check mtimes rather than trusting a clean status.
- **Do not write `.env`.** `.env.example` only. A subagent once overwrote Kyle's real credentials.
- **`pnpm watch` in Task 5 Step 5 runs against the local development database and the repo's `output/`.** That is the intended hand-run behaviour and the startup line will say so. It does not touch `~/.herald/output` or production unless those variables are set.
- If a test you were told would pass fails instead, stop and report it rather than adjusting the test to match the code. The point of the pre-existing `--limit 3` assertions is that they were not supposed to move.
