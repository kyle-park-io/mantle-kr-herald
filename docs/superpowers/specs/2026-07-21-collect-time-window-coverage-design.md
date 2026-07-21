# Collect time bounds + coverage tracking — Design

**Date:** 2026-07-21
**Status:** Approved (pending spec review)
**Scope:** X collection (`pnpm collect`) only

## Problem

`pnpm collect` currently accepts only a target argument. Internally it uses a
per-target watermark (auto `since_time`) plus a `MAX_PAGES = 50` backstop. There is:

- no way to manually bound a run by time (e.g. "just the last 3 days"),
- no count cap (a busy window can pull the whole `MAX_PAGES` crawl),
- no record of *what range* a run actually covered, so we cannot tell what was
  swept and what is missing.

We also want to run collection on an hourly schedule with **guaranteed coverage**,
which the strict watermark approach does not robustly provide (it is fragile to
API indexing lag and clock jitter — a tweet indexed slightly late, after the
watermark has advanced past its `createdAt`, is skipped forever).

## Goals

1. Add manual `--since` (time floor) and `--limit` (count cap) flags for ad-hoc pulls.
2. Record per-run coverage — requested range, actually-covered range, and any gap —
   so we can see what was covered and what is missing.
3. Support a robust hourly **sliding-window** automation pattern for near-perfect coverage.

## Decisions (locked)

- **Time axis: `createdAt`.** The discovery API (`advanced_search` + `since_time` +
  `Latest`) is creation-time based; there is no "edited-since" query, so a floor/sweep
  can only be built on `createdAt`. Edit handling (`updatedAt`) is **out of scope** —
  see *Known limitations*.
- **`--since` = floor.** Accepts relative (`3d` / `12h` / `1w`) or ISO date/datetime
  (`2026-07-18`, `2026-07-18T09:00:00Z`), normalized to ISO. `m` is **not** supported
  (month/minute ambiguity).
- **`--limit` = max threads** (뭉텅이 / 타래), a count of assembled threads, not tweets.
- **Stop rule:** `--since` bounds the crawl (stop at floor); `--limit` truncates the
  assembled result to the newest N threads. The dropped older portion of the window
  becomes the reported gap.
- **Watermark rule:** `--since` overrides the watermark floor. **If either `--since`
  or `--limit` is passed, the run is ad-hoc and does NOT advance the watermark.** A
  flag-less `collect` is unchanged: watermark-driven incremental that advances the
  watermark. Rationale: a truncated or manually-bounded run must not move the
  incremental cursor, or the next flag-less run would skip un-fetched history.
- **Coverage record:** every `collect` run (flag-less and ad-hoc) appends one record
  to `output/x/runs.json` and prints a console summary.
- **Storage unchanged:** `LocalJsonStore.upsert` merges by `rootId`/tweet `id`, so
  overlapping/ad-hoc re-fetches are idempotent (no duplicates).

## CLI surface

```
pnpm collect [target] [--since <3d|12h|1w|ISO>] [--limit <n>]
```

Examples:

```
# ad-hoc: newest 20 threads from the last 3 days (watermark untouched)
pnpm collect Mantle_Official --since 3d --limit 20

# sliding-window cron unit (see automation pattern below)
pnpm collect Mantle_Official --since 2h

# unchanged incremental (advances watermark)
pnpm collect Mantle_Official
```

## Collection behavior

1. **Floor resolution.** If `--since` is given, use its normalized ISO as the floor;
   otherwise use `watermark.get(target)` as today.
2. **Crawl.** `fetchAuthoredTweets(target, floor)` is unchanged — newest-first,
   client-side watermark stop, bounded by `MAX_PAGES`.
3. **Limit (threads).** After assembly, sort threads newest-first and keep the newest
   N. The older threads in the window that were dropped define the truncation gap.
   (Applying the limit post-assembly guarantees each kept thread is complete; an
   early crawl-stop optimization can be added later if large windows become costly.)
4. **Watermark advance.** Only when neither flag is passed, set the watermark to
   `max(createdAt)` as today. When a flag is present, skip the watermark update.
5. **Coverage computation.** Compute requested range, covered range, truncated flag,
   and gap (see below), then append a run record.

## Coverage record

Written to `output/x/runs.json` (append-only array), one record per run:

```json
{
  "target": "Mantle_Official",
  "ranAt": "2026-07-21T09:00:00Z",
  "requested": { "since": "2026-07-18T09:00:00Z", "until": "2026-07-21T09:00:00Z" },
  "covered":   { "from": "2026-07-19T14:00:00Z", "to": "2026-07-21T08:30:00Z" },
  "threadCount": 20,
  "tweetCount": 47,
  "truncated": true,
  "gap": { "from": "2026-07-18T09:00:00Z", "to": "2026-07-19T14:00:00Z" }
}
```

- `requested.since` = the floor used (flag value, or the watermark for flag-less runs).
  `requested.until` = run time (`now`).
- `covered.from` / `covered.to` = min / max `createdAt` among threads kept this run.
  When nothing new was found, `covered` is `null`.
- `truncated` = `true` when `--limit` dropped older threads before reaching the floor.
- `gap` = `{ from: requested.since, to: covered.from }` when `truncated`; otherwise `null`.
- Console summary, e.g.:
  `collected 20 threads (47 tweets) — covered 7/19 14:00 ~ 7/21 08:30, GAP 7/18~7/19 (limit reached)`

Recording **all** runs (not just flagged ones) means the ledger is a complete coverage
history: laying consecutive `covered` ranges end to end proves continuity, and a
missing hourly record flags a suspect window.

## Recommended automation pattern (hourly sliding window)

For guaranteed coverage, schedule hourly:

```
collect <target> --since 2h        # NO --limit
```

- **2h window + 1h cadence = 1h overlap.** Every instant is covered by ~2 runs, so a
  single failed/late run (up to 1h) leaves no gap, and API indexing lag is absorbed.
- `upsert` dedupes the overlap; `--since` keeps the watermark untouched (the window
  *is* the mechanism).
- **Do not set `--limit` on this cron** — truncation reintroduces gaps. `--limit` is
  for manual ad-hoc pulls only.
- The `MAX_PAGES = 50` backstop remains as a safety net.

## Architecture (hexagonal)

- `CollectAuthoredContent.run(userName, opts?: { since?: string; limit?: number })` —
  add the options argument; resolve floor, apply thread limit, gate watermark advance,
  compute coverage, and record via the ledger. Extend `CollectResult` with the
  coverage fields (or return a `coverage` object).
- **New port** `CollectionRunLedger` with `record(run: CollectionRun): Promise<void>`.
- **New adapter** `JsonCollectionRunLedger` — append to `output/x/runs.json` via the
  existing `readJsonFile` + `writeJsonFileAtomic` helpers, mirroring `LocalJsonStore`.
- **New util** `parseSince(value: string, now: Date): string` — relative (`Nd`/`Nh`/`Nw`)
  and ISO parsing → ISO string; throws on invalid input.
- `collect.ts` — parse `--since` / `--limit` via `args.ts` helpers, call `parseSince`,
  wire the ledger, print the summary.
- `TwitterApiSourceGateway.fetchAuthoredTweets` is unchanged (already takes `sinceTime`).

## Testing

- `parseSince`: relative units (`3d`/`12h`/`1w`), ISO date + datetime, invalid input throws.
- Thread limit: keeps newest N, drops older, marks `truncated` + `gap`.
- Watermark: advances on flag-less run; does **not** advance when `--since` or `--limit`
  is present.
- Coverage: full cover (no gap), truncated (gap), empty (`covered: null`).
- Ledger adapter: appends without clobbering prior records; atomic write.

## Known limitations / future work

- **Edits not captured.** `updatedAt` is not modeled and edits made within X's ~1h edit
  window are not re-fetched. Requires a separate spec and a probe of how twitterapi.io
  returns edited tweets (same id vs new `edit_history_tweet_ids`, `updatedAt` presence).
- **`items.json` unbounded growth.** Full load + rewrite per run; fine at current scale.
  Retention is handled by existing `archive`/`clean`; revisit if volume grows.
- **No file lock.** `upsert` is read-modify-write with no lock, so concurrent `collect`
  processes can clobber each other. Automation MUST serialize runs (single cron, no
  overlapping *process*; a `flock`-style guard is recommended at the scheduler level).
- **`runs.json` append-only growth.** Rotate/prune later if it becomes large.

## Out of scope

- Lark collection (the `CollectionRunLedger` port is kept generic for future reuse).
- `--until` ceiling (floor-only for now).
- Edit/`updatedAt` handling (decision A).
