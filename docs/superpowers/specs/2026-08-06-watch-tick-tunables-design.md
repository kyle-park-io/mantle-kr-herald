# Watch tick tunables — the knobs, and the loss one of them can open

The watch scheduler shipped with its numbers spread across three files and its relationships
written in prose. This makes the one number worth tuning into configuration, turns the
relationships into tests, and closes a silent tweet-loss path that "make the batch size
configurable" would otherwise widen.

Written 2026-08-06, one day after the scheduler was armed. Every claim below was read out of this
repo at that date, with file and line, not assumed from how schedulers usually work.

## The question this started from

> 어느 인터벌로, 그리고 동작 시간 기준 -x H 까지 트윗을 가져올 건지 이런거 변수화해두면 좋지 않나?

Two halves, with two different answers. The interval and the batch size are genuinely hardcoded and
worth addressing. The `-x H` lookback does not exist anywhere in the pipeline — and it should stay
that way. The reasoning is recorded below, because the next person to look at this will have the
same instinct and deserves more than "we decided not to".

## What is hardcoded today

| Value | Where | Configurable? |
| --- | --- | --- |
| Fire interval | `deploy/herald-watch.timer` → `OnCalendar=*-*-* 0/2:17:00` | No — unit file literal |
| Tick timeout | `deploy/herald-watch.service` → `TimeoutStartSec=1800` | No — literal, and coupled to the interval |
| Batch size | `src/app/WatchTick.ts:140` and `:210` → `["--limit", "3"]` | No — code literal, twice |
| Collect reach | file watermark, `%h/.herald/output/x/state.json` | A file, but no time window exists |
| Translation floor | `HERALD_TRANSLATE_SINCE` on the service unit | Yes, absolute ISO instant |

The interval and the timeout are coupled and the coupling lives only in a comment.
`herald-watch.service`'s own header argues that 1800s must stay "well under" the timer's 7200s
period, because systemd skips an `OnCalendar=` fire that comes due while the unit is still active —
"a scheduler that looks armed but has silently stopped". Meanwhile `herald-watch.timer`'s header
invites exactly the edit that tests that bound: *"hourly (`*-*-* *:17:00`) is a one-line change once
it has run unattended for a few days without surprises."* One file invites a change the other file's
correctness depends on, and nothing checks the pair.

## Why there is no `-x H` lookback, and why there should not be

**The watermark is the better answer to the same problem.** It records the newest tweet `createdAt`
collect has seen and fetches strictly after it, so there is no window to size: no duplicates on a
short interval, no gap on a long one, and a machine that was off simply gets a larger catch-up on
the next fire — which is the premise `Persistent=true` in the timer is built on.

**A relative window cannot be added without breaking the watermark.** `CollectAuthoredContent.ts:32`
sets `adhoc = true` whenever `opts.since` or `opts.limit` is present, and the `if (!adhoc)` at `:74`
skips the watermark advance entirely for such a run. A tick that passed `--since 6h` would therefore freeze the
watermark, re-fetch the same window every two hours, and — because collect's thread count would
never be zero again — permanently disable the "0 new threads → never touch the agent" gate at
`WatchTick.ts:133`. The knob would cost API calls and a subscription turn per tick to buy nothing.

**A cap silently discards content.** The one thing `-x H` offers over the watermark is bounding how
far back a single tick reaches. Used as a floor (`max(watermark, now - XH)`), a 24h cap on a box
that was off for three days drops two days of @Mantle_Official posts with no failing unit and
nothing to read. That is the failure the team's standing rule — the backlog cutoff is the last
*translated* post — exists to prevent, and it defeats the reason `Persistent=true` is set. It also
does not protect against the incident that actually happened: a dev run advanced the shared
watermark 39 threads *past* what production had seen (`src/paths.ts`'s `OUTPUT_DIR` doc comment). A
floor is the wrong shape for that bug.

**Someone already wrote the wrong version down.** `docs/ko/team-runbook.md:417-419` closes its
watermark section with *"자동화를 붙일 때는 매시간 `pnpm collect <target> --since 2h`(`--limit` 없이)를
권장합니다"* — schedule an hourly collect over a two-hour window, so the windows overlap and upsert
dedupes. It predates the watch scheduler and it is exactly the trap above: a scheduled `--since` is
an adhoc run, so the watermark freezes and the zero-threads gate never fires again. That paragraph is
corrected as part of this work; it is also the best evidence that the decision needs to be recorded
rather than assumed.

**Collection is lossless, translation is policy.** A tweet not collected cannot be un-missed, so
collect should always reach as far back as the watermark says. Which historical posts the Korean
account chooses never to translate is a human decision on a human clock, which is what the absolute
`HERALD_TRANSLATE_SINCE` already is (`src/cli/translateSince.ts`). Making *that* relative would mean
the set of permanently-untranslated posts grows every hour on its own.

## What the watermark actually guarantees

"No tweets are lost" holds under one condition, and this is where the loss path is.

`fetchAuthoredTweets` pages **newest-first** (`queryType: "Latest"`,
`TwitterApiSourceGateway.ts:36`) and stops at `MAX_PAGES = 50` (`:8`, `:33`), returning `true` to
mean "there were more pages" (`:57-58`). `CollectAuthoredContent` ORs that into `truncated` (`:49`)
— and then advances the watermark to the newest fetched tweet regardless (`:74-79`):

```ts
if (!adhoc) {
  const maxCreatedAt = this.maxCreatedAt(fetched);   // max over fetched, ignores `truncated`
  if (maxCreatedAt && (!floor || maxCreatedAt > floor)) {
    await this.watermark.set(userName, maxCreatedAt);
  }
}
```

Newest-first plus a page cap means the tweets that were *not* fetched are the **older** ones. The
next tick's floor is already newer than that hole, so it is skipped permanently. The watermark is
lossless exactly as long as one collect finishes inside 50 pages.

**Advancing the watermark is nonetheless correct.** Holding it back on a truncated run deadlocks:
the next run re-fetches the same newest 50 pages, truncates again, and never progresses. One scalar
cannot express "complete up to here, plus a hole over there". So the honest design is to advance and
*say so* — and the backfill tool already exists, because an adhoc `collect --since <hole>` is
precisely a run that does not touch the watermark.

**Today nothing says so.** `computeCoverage` records the hole (`src/domain/coverage.ts`: `gap` is set
whenever `truncated` and at least one tweet was kept — and hitting a 50-page cap guarantees the
latter), and `collect.ts:41` prints it as `, GAP <from> ~ <to> (limit reached)`. But
`WatchTick.ts:17-18` states its own contract: *"the rest of the line (coverage window, gap notice) is
free text we don't need to parse."* The tick reads the leading count and nothing else. A permanent
loss therefore produces a green tick, no `OnFailure=` alert, and one line in a journal nobody reads.

**And this change would widen it.** Passing a batch size to collect's `--limit` opens the same hole
at any interval: `applyThreadLimit` drops threads (`src/domain/threadLimit.ts`) while the watermark
still advances to the newest *fetched* tweet, including the dropped ones. The tick does not pass
`--limit` to collect today (`WatchTick.ts:116` calls it with `[]`), and must not start.

## The design

### One batch-size variable, validated before anything runs

`HERALD_WATCH_BATCH`, default `3`, parsed by a new `src/cli/watchBatch.ts` — a pure function beside
`translateSince.ts` and for the same reason: a top-level script has no test coverage, so the
decision has to live somewhere testable. It rejects anything that is not a positive integer, and
treats `""` as unset, because an `HERALD_WATCH_BATCH=` line with nothing after it reaches Node as the
empty string. `watch.ts` calls it before the startup line and before any stage, so a typo'd value
fails the tick at the entry point where `registerErrorHandler` turns it into the non-zero exit the
`OnFailure=` hook is watching for — the same posture `parseTranslateSince` already has.

The parsed number reaches `WatchTick` as an option and replaces both `--limit 3` literals. **One
knob for both stages, not two.** They are 3 and 3 today and there is no evidence they need to
diverge; if alignment ever needs its own ceiling, that is a second variable at that time.

The tick timeout does **not** scale with it. `claude -p` is called per worksheet, not per item, so a
batch of 3 and a batch of 10 are still at most two agent calls — the arithmetic behind 1800s in
`herald-watch.service`'s header is unchanged. That reasoning goes in the unit's comment, because the
next person to raise the batch size will ask.

### The interval stays in the timer, and the coupling becomes a test

`OnCalendar=` is systemd's own field; it cannot read an environment variable, so there is no way to
move the interval out of `herald-watch.timer`. What can move out of prose is the constraint. A new
`tests/deploy/watchTiming.test.ts` reads both unit files, derives the period from `OnCalendar=`, and
asserts `TimeoutStartSec ≤ period / 2`.

The parser handles only the two shapes this timer will plausibly use — `*-*-* H/N:MM:SS` (every N
hours) and `*-*-* *:MM:SS` (hourly) — and **fails on anything else** rather than skipping the
assertion. A calendar spec the parser does not understand means the coupling is unchecked, which is
the state this test exists to end; passing quietly would be worse than not having it. The bound is
`period / 2` deliberately: it admits the hourly change the timer's comment already sanctions
(1800 ≤ 1800) while rejecting anything faster.

This mirrors `tests/deploy/watchCutoff.test.ts`, which turned "the two floors must match" from a
runbook sentence into a check for exactly the same reason.

### A GAP fails the tick

`parseCollectedThreadCount` becomes `parseCollect`, returning `{ threadCount, gap }` — the existing
`COLLECT_LINE` pattern extends to capture the tail of the line after `— ` so the `, GAP ` marker is
visible. Unrecognised stdout keeps the same contract it has for every other stage in that file:
`undefined`, and the caller fails.

When `gap` is true the tick fails immediately, before `translate:prepare`. The collected threads are
already committed to Postgres by then, so nothing is lost by stopping — the next tick's `prepare`
picks them up — and the alert reaches a human before more translation is layered on an incomplete
corpus. The failure detail names the cause and the remedy, because it is what lands in the Telegram
alert: the tick never passes `--limit` to collect, so `(limit reached)` in a scheduler journal can
only mean the `MAX_PAGES` cap, and the fix is an adhoc `pnpm collect --since <from>` that backfills
without touching the watermark.

This fires once, not forever. The watermark has already advanced past the hole, so the following
tick collects a normal window and goes green — which is the right behaviour for an alert about a
one-time event.

### The tick's collect call is pinned by a test

`WatchTick` must call the collect stage with no arguments. A test asserts it, with the reason
attached: `--since` freezes the watermark and kills the zero-threads gate, `--limit` opens the loss
path above. Both are things a future "make it configurable" change would reach for first.

### The startup line records what the tick ran with

`watchStartupLine` gains the effective batch size and the translation floor, so every entry in
`journalctl --user -u herald-watch` says which values produced it. The line already exists to make a
wrong output root or database visible in the journal rather than only under `pnpm doctor`; the two
values a human can now change belong in the same place. An unset floor prints as such rather than
being omitted, so the line never reads as if a cutoff were configured when it is not.

### `.env.example`, with a test

`HERALD_WATCH_BATCH` goes in §1 beside `HERALD_OUTPUT_DIR` and `HERALD_TRANSLATE_SINCE`, including a
row in the table at the top of the file, and marked the same way — only `pnpm watch`'s systemd unit
sets it. A test asserts its presence, extending the one `watchCutoff.test.ts` already makes for the
cutoff, because a documented variable with nothing checking the documentation rots at the first
rename.

## Out of scope, deliberately

- **`CollectAuthoredContent`'s watermark logic is untouched.** Every collect caller shares it,
  including hand runs, and its current behaviour is right (see the deadlock argument above). The
  tick learns to notice the consequence; the use case does not change.
- **`MAX_PAGES` stays at 50.** Raising it trades one bounded failure for an unbounded crawl. The
  cliff is now alarmed, which is what makes it survivable.
- **The `(limit reached)` wording stays.** It names one of the two causes that set `truncated`, and
  `collect.ts` and `collect-reference.ts` both carry the string. Making it precise means recording
  the cause in `CollectionRun`, which is the use-case change ruled out above. The tick's own failure
  detail carries the precise explanation instead.
- **No `-x H` lookback**, for the four reasons in full above.
- **The interval value itself does not change.** Going hourly stays a human edit plus
  `systemctl --user daemon-reload`; this work only makes that edit safe to make.

One thing not in the original scope is in it now: `docs/ko/team-runbook.md`'s stale recommendation to
schedule `pnpm collect --since 2h` is corrected, and a GAP-alert procedure is added beside it. A
runbook that recommends the loss path this spec exists to close cannot be left standing.

## Testing

| Test | Asserts |
| --- | --- |
| `tests/cli/watchBatch.test.ts` | default 3; `""` → default; rejects `0`, negatives, non-integers, non-numerics; `.env.example` documents the variable |
| `tests/app/watchTick.test.ts` | batch reaches both `translate:prepare` and `translate:align`; collect is called with `[]`; a `GAP` line fails the tick before `prepare`; a gapless line still runs the tick |
| `tests/deploy/watchTiming.test.ts` | `TimeoutStartSec ≤ OnCalendar` period / 2; an unparseable `OnCalendar=` shape fails |
| `tests/cli/watchStartup.test.ts` | batch size and translation floor appear; unset floor is stated, not omitted |

`tests/deploy/watchCutoff.test.ts` is left alone — its subject is the two cutoffs, and the batch
variable's documentation guard belongs beside the parser it documents.
