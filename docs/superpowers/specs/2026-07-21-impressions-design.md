# Impression collection (§9b) — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** subsystem §9b, ③ of the Sheet data hub — read the `history` tab, fetch each published X
post's current view count, and write it back. X only for v1.

## Context

The Google Sheet `history` tab (built in §9a, PR #15) has a nine-column header:

```
A itemId · B type · C channel · D postId · E url · F status · G publishedAt · H impressions · I impressionsAt
```

`RecordPublish` (§9a ②) writes **only A–G**, deliberately leaving **H (impressions)** and
**I (impressionsAt)** empty for this subsystem. §9b fills them.

For an X post, "impressions" is the tweet's **view count**. The existing X source gateway already
exposes exactly what is needed:

- `SourceGateway.fetchByIds(ids: string[]): Promise<SourceTweet[]>` — used today by `reconcile`
  (deletion detection). `TwitterApiSourceGateway.fetchByIds` calls
  `GET /twitter/tweets?tweet_ids=<comma-joined>` and returns the tweets **still alive** among the
  ids, parsed into `SourceTweet`.
- `SourceTweet.metrics?.viewCount?: number` — the current view count is already on the returned
  domain object (`normalizeTweet` → `toMetrics`).

So §9b needs **no new port, no new adapter, and no new twitterapi.io endpoint** — it composes the
two existing ports (`SheetClient` + `SourceGateway`) in one new use-case.

### Dependency — built now, not live-verified yet

Two upstream pieces are not flowing yet, and this was accepted before designing:

1. **The Sheet is not live.** `targets:list`/`history:record`/§9b all need the `spreadsheets` OAuth
   scope re-minted onto the token (`GOOGLE_OAUTH_SCOPE` + `pnpm google:auth`). Until then §9b is
   code-complete and unit-tested but not run against a real spreadsheet — the same state §9a is in.
2. **The `history` tab is barely populated.** Its only writer is `RecordPublish`, which is invoked
   automatically only by §8 (upload, not built); today rows appear only via a manual `history:record`.

§9b is built now anyway (X-only, fully unit-tested), because the seam is ready and the code is
small. §8 (which would auto-populate `history`) is a larger, separate effort deferred by choice.

## Decisions

- **Impressions = `viewCount` only.** The H/I schema is unchanged; no new columns.
  - Breadcrumb (to leave in the use-case and here): `fetchByIds` already returns the full
    `SourceTweet.metrics` — `likeCount`, `retweetCount`, `replyCount`, `quoteCount`,
    `bookmarkCount` are all present at fetch time for free. If engagement metrics are ever wanted,
    the change is additive: append columns (J/K/…) to `HISTORY_HEADER` + `sheet:init`, and capture
    the extra fields here. Not done for v1 (YAGNI; the column is named "impressions", which is
    exactly the view count).
- **Refresh policy: refresh every eligible X row on each run** (view count is a moving number; you
  run this periodically to update it). An optional `--since <YYYY-MM-DD>` flag narrows the set to
  rows whose `publishedAt` (col G) is on or after the cutoff, matching the existing `--since`
  convention in `translate:prepare` / `convert:prepare`.
- **Reuse `SourceGateway.fetchByIds`** rather than adding an impressions-specific endpoint — same
  call, same parsing.
- **CLI name: `impressions:record`** — `record` matches "write to the sheet" and mirrors
  `history:record`.
- **Mode-gated like the other Sheet commands:** `skipIfLocal("impressions:record")` — it reads and
  writes the Sheet, which is a cloud credential, so it is a no-op (exit 0) in `local` mode.

## Design

### 1. Components — one use-case, one CLI, no new port

- **Create `src/app/RecordImpressions.ts`.** Constructor injects `SheetClient`, `SourceGateway`, and
  `now: () => Date = () => new Date()` (mirrors `RecordPublish`). Exposes
  `run(opts?: { since?: string }): Promise<ImpressionsResult>`.
- **Create `src/cli/impressions-record.ts`.** Thin composition root:
  `import "./registerErrorHandler"`, `skipIfLocal("impressions:record")`, read `--since` via
  `argValue`, build `GoogleSheetClient` (as `targets:list` does) + `TwitterApiSourceGateway` (as
  `collect` does), run, print the summary, exit 1 on any failure.
- **Add `"impressions:record": "tsx --env-file-if-exists=.env src/cli/impressions-record.ts"`** to
  `package.json` scripts.

### 2. Data flow (in `RecordImpressions.run`)

1. `rows = await sheet.getValues("history!A2:I")` — every data row (header is row 1).
2. **Select eligible rows**, keeping each row's 1-based sheet row number (index + 2):
   - `channel` (col C, index 2) `=== "x"`, and
   - `postId` (col D, index 3) is a non-empty string, and
   - if `since` given: `publishedAt` (col G, index 6) `>= since` (string compare on ISO/date works).
3. If no eligible rows → return zeroed counts (nothing to do).
4. `tweets = await source.fetchByIds(eligiblePostIds)` → build `Map<id, viewCount>` from
   `t.metrics?.viewCount` (only ids present with a defined view count).
5. For each eligible row:
   - view count found → `sheet.updateValues("history!H{rowNumber}:I{rowNumber}", [[String(viewCount), nowISO]])`; `updated++`.
   - id not returned (deleted/unavailable) or view count `undefined` → leave H/I untouched; `skipped++`.
   - `updateValues` throws → catch, `failed++`, record `{ postId, error }`; continue.
6. Return `{ updated, skipped, failed, failures }`.

**Writes touch only H/I.** A–G belong to `RecordPublish`; §9b never writes them, symmetric to
`RecordPublish` writing only A–G. The two subsystems share the row but own disjoint columns.

### 3. Error handling — per-row graceful skip

- A tweet the API does not return (deleted, protected) simply is not in the map → that row is
  skipped, its existing H/I preserved. This is the same "still alive" semantics `reconcile` relies
  on, so no deletion handling is duplicated.
- A tweet with no `viewCount` (metrics absent) → skipped, not written as `0`.
- A per-row `updateValues` failure is isolated: counted, its reason captured, and the remaining rows
  still processed — mirroring `PublishTranslations`' failure isolation.
- The CLI prints `impressions: N updated · M skipped · K failed` and sets exit code 1 when
  `failed > 0`. `skipped` is normal (not a failure), so it does not affect the exit code.

### 4. Domain type

```ts
export interface ImpressionFailure { postId: string; error: string }
export interface ImpressionsResult {
  updated: number;
  skipped: number;
  failed: number;
  failures: ImpressionFailure[];
}
```

Defined in `src/app/RecordImpressions.ts` (small, use-case-local, like `PublishResult`).

## Testing

Unit tests with injected fakes for `SheetClient` and `SourceGateway` (no network), in
`tests/app/recordImpressions.test.ts`:

- Writes `viewCount` + timestamp to **H/I only** for an X row, leaving A–G untouched.
- Skips non-X rows (a `telegram`/`kakao` row is never fetched or written).
- Skips an X row whose `postId` is empty.
- `--since` filters to rows with `publishedAt >= cutoff`.
- A `postId` the gateway does not return (deleted tweet) → that row skipped, counted in `skipped`.
- A tweet with `metrics` absent / `viewCount` undefined → skipped, not written as `0`.
- A row whose `updateValues` throws → counted in `failed` with its reason, other rows still written.
- The correct sheet row number is targeted (row index + 2), verified by the range string.
- Injected `now` produces a deterministic `impressionsAt`.

**Live verification is deferred** to when the `spreadsheets` scope is minted — identical status to
§9a. A probe against a real sheet is a manual follow-up, not part of this spec.

## Notes / deferred

- **Batch size.** `fetchByIds` joins all ids into one `tweet_ids=` call and does not chunk;
  `reconcile` uses it the same way. The `history` X-row count is small, so v1 reuses it unchanged.
  If the row count ever approaches the twitterapi.io per-call id cap, chunking belongs in
  `fetchByIds` (shared with `reconcile`), not here.
- **Engagement metrics (like/retweet/…)** — additive extension described under Decisions; not v1.
- **`RecordPublish` is untouched.** §9b only reads what it wrote and fills the reserved columns.
