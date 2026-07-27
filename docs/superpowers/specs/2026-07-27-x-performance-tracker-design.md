# X performance tracker — KR official + X KOLs — design

Date: 2026-07-27
Status: approved for planning

## Context

The KR team keeps a human-maintained Q3 workbook (`2026 Q3 KR Work Sheet.xlsx`, copied into a Google
Sheet the team owns) with a KOL roster (`KOL list`), contracts (`Q3 KOL 계약 리스트`), and monthly KOL
performance tabs (`Jul.`/`Aug.`/`Sep.`) whose metric columns (followers, Posts, Views, Engagement,
rates) are filled by hand. This sub-project **automates the metric numbers** the pipeline can fetch
from X, for the KR official account and the X-based KOLs, and writes them into a machine-owned tab in
that same workbook.

**What is and isn't automatable** (the boundary that drove the design):

- **Automatable (machine writes):** raw X performance numbers — followers, posts, views, engagement —
  for any X account, per month, via twitterapi.io.
- **Not automatable (stays human):** the roster (who is a KOL, tier, type), contracts (price,
  deliverables, status, payout tx), emails, affiliate info — business/relationship facts the pipeline
  has no source for. Telegram-based KOLs' metrics (twitterapi.io is X-only).
- **Derived (sheet formulas, not this writer):** Avg views, Engagement Rate, Cost per Impression, etc.
  — these combine machine metrics with human cost data and live as spreadsheet formulas so they
  recompute automatically and reference the human cost columns.

So the workbook becomes a single unified surface: the pipeline auto-fills the X metric numbers it can
fetch; humans own the roster, money, and the Telegram rows; formulas do the analytics.

This is independent of §8 (channel delivery) — it is a measurement/reporting feature that delivers
value on its own by populating the team's real workbook with live numbers.

## Decisions

### 1. One machine-owned, normalized tab — human tabs are never touched

The writer targets a single tab, `x-performance`, that the pipeline **owns**. Row granularity is one
row per `(account, month)`. Columns:

```
account | name | type | month | followers | posts | views | engagement | fetchedAt
```

- `account` — the X handle without `@` (e.g. `0xMantleKR`); the upsert key together with `month`.
- `name` — human-readable label (roster `KOL` value for KOLs; `Mantle KR` for the official account),
  so humans can join back to the roster.
- `type` — `official` | `kol`.
- `month` — `YYYY-MM`.
- `followers` `posts` `views` `engagement` — the raw fetched numbers.
- `fetchedAt` — ISO timestamp of the fetch.

The pipeline **only ever reads** the human tabs (`KOL list`) and **only ever writes** `x-performance`.
It never writes the roster, contract, or existing monthly tabs, and never writes cost columns. This is
enforced by fixed A1 ranges and covered by tests. Kyle's familiar monthly layout is reproduced, if
wanted, as a pivot/formula view over `x-performance` — not by the writer.

### 2. Raw metrics only; derived ratios and cost stay as sheet formulas

`x-performance` holds only the four raw numbers. Avg/rates/Cost-per-Impression are **not** written by
the pipeline — they are spreadsheet formulas (added once by a human) that reference `x-performance`
plus the human cost columns. This keeps the writer's contract tiny and means the pipeline never needs
cost data.

### 3. The roster is read by header name, defensively

`KOL list` is a human sheet with an irregular shape (a header row, section-label rows like
`In contract`, mixed platforms, possibly blank links). The reader:

- reads the header row and maps **column name → index** (`KOL`, `Social media`, `Social media link`),
  so a human reordering columns does not break it;
- keeps only rows whose `Social media` is X/Twitter **and** whose `Social media link` yields a usable
  X handle;
- **skips** everything else (section rows, Telegram rows, blank/malformed links) without error.

Handle extraction: from a `Social media link` that is an `x.com/<handle>` or `twitter.com/<handle>`
URL, or a bare `@handle`/`handle`. A row marked X whose link is not parseable to an X handle is skipped
with a per-row warning (non-fatal).

The roster tab name (`KOL list`) and the three column names are named constants, documented as coupled
to the team workbook. Tab names containing spaces are quoted in A1 ranges (`'KOL list'!1:1`).

### 4. Official account is `@0xMantleKR` (constant), always measured

The KR official account is a fixed input (`REFERENCE_X_HANDLE` already defaults to `0xMantleKR`; this
feature reuses it), written with `type: official`, `name: Mantle KR`. It is not in the roster.

### 5. Small additive extensions to existing adapters

- `UserProfile` gains `followers?: number`; `parseUserProfile` captures it (the `/twitter/user/info`
  response already returns `followers`). No new endpoint.
- `SheetClient` gains a tab-ensure capability so the writer can create `x-performance` if absent
  (`ensureTab(title)` → a Sheets `batchUpdate` addSheet, a no-op if the tab already exists).
  `GoogleSheetClient` implements it. Reading the roster and upserting rows use the existing
  `getValues` / `updateValues` / `appendValues` (the upsert mirrors `RecordPublish`: read the range,
  match `(account, month)`, then update that row or append).

### 6. Monthly aggregation from a bounded advanced_search

For each account and a target month `[monthStart, monthEndExclusive)`:

- `posts` = count of the account's authored tweets in the window,
- `views` = Σ `viewCount`,
- `engagement` = Σ (`likeCount` + `retweetCount` + `replyCount` + `quoteCount`),

computed by a pure function over the fetched `SourceTweet[]`. `followers` is a point-in-time snapshot
from `fetchUserProfile` at fetch time (X gives no historical follower count). The month window uses
advanced_search `from:<handle> since:.. until:..`; the existing `fetchAuthoredTweets` takes only a
`sinceTime`, so the plan either adds an `until` bound or fetches from `monthStart` and filters client
side to `< monthEndExclusive` (with the `MAX_PAGES` cap noted as a coverage limit for very prolific
accounts).

## Architecture

- **`metrics:record [--month YYYY-MM]` CLI** — `skipIfLocal`-gated (cloud feature). Default month =
  the current month. Composes the pieces below and upserts one row per account for that month.
- **`LoadRoster`** (app) — reads `'KOL list'` via `SheetClient`, returns the X KOLs it could resolve
  (`{ name, handle }[]`), skipping the rest.
- **`aggregateMonth(tweets, window)`** (pure domain, `src/domain/metrics/`) — `{ posts, views,
  engagement }` from a month's `SourceTweet[]`.
- **`RecordMetrics`** (app) — for `[official, ...xKOLs]`: `fetchUserProfile` (followers) +
  month-bounded authored tweets → `aggregateMonth` → upsert `(account, month)` row into
  `x-performance` (create the tab + header if absent).
- **Reused:** `SheetClient`/`GoogleSheetClient`, `SourceGateway.fetchUserProfile`, advanced_search,
  `TweetMetrics`, `skipIfLocal`, `createGoogleAuth`, config (`GSHEET_ID`, `REFERENCE_X_HANDLE`).

### Data flow

```
metrics:record --month 2026-07
  │
  ├─ LoadRoster  ← SheetClient.getValues('KOL list'!…)      → X KOLs [{name,handle}]
  │                                                            (Telegram/blank rows skipped)
  ├─ accounts = [{name:"Mantle KR", handle:"0xMantleKR", type:"official"}, ...xKOLs(type:"kol")]
  │
  └─ for each account:
        followers ← fetchUserProfile(handle)
        tweets    ← authored tweets in [2026-07-01, 2026-08-01)
        {posts,views,engagement} ← aggregateMonth(tweets, window)
        upsert (account, "2026-07") row → x-performance     (ensureTab first)
```

## Error handling

- Missing `GSHEET_ID` / non-cloud mode / missing Sheets scope → the existing config + `skipIfLocal`
  paths (`skipIfLocal` exits 0 in local; a scope/permission error surfaces via `registerErrorHandler`).
- A roster row that is not a resolvable X account is skipped (per-row, non-fatal) — Telegram and blank
  links are the norm, not errors.
- A deleted/protected/zero-post account yields `posts:0, views:0, engagement:0` and still writes a row
  (0 is written, not skipped) so a month with no activity is recorded rather than looking un-run.
- A per-account fetch failure (HTTP error) is logged and that account is skipped; other accounts still
  record. The run reports how many accounts were recorded vs skipped.

## Testing

- `aggregateMonth` — sums views/engagement and counts posts over a fixture `SourceTweet[]`; a tweet
  outside the window is excluded; missing metric fields count as 0; empty input → all zeros.
- Roster reader — header-name mapping resolves columns regardless of order; an X row with an
  `x.com/<h>` link resolves; a Telegram row, a section-label row, and an X row with a blank/garbage
  link are all skipped; handle extraction strips `@`, `x.com/`, `twitter.com/`, trailing `/`.
- `parseUserProfile` — now also returns `followers` when present, `undefined` when absent; existing
  cases still pass.
- Upsert — a second run for the same `(account, month)` overwrites its row (no duplicate); a new month
  appends; `views:0` is written as `"0"`.
- `ensureTab` — creating an existing tab is a no-op; a missing tab is created with the header row.
- Every assertion pins a concrete value (no test that cannot fail); all data in tests is synthetic —
  **no real KOL names, handles, emails, or numbers from the team workbook appear in the repo.**

## Non-goals

- **Telegram KOL metrics** — twitterapi.io is X-only; Telegram rows stay manual.
- **Derived analytics** (Avg, rates, Cost-per-Impression) — spreadsheet formulas, not the writer.
- **Roster / contract / payment management** — human-owned; the pipeline only reads the roster.
- **Per-post detail or campaign attribution** — monthly aggregate per account only.
- **Historical follower counts** — `followers` is a fetch-time snapshot.
- **Writing Kyle's existing `Jul./Aug./Sep.` tabs** — the writer owns only `x-performance`.

## Global constraints

- Runtime deps stay zod-only.
- Cloud-only: requires `HERALD_STORAGE_MODE=cloud`, the OAuth `spreadsheets` scope, and
  `GSHEET_ID` = the team Q3 workbook. `metrics:record` is `skipIfLocal`-gated.
- Public repo: never commit the workbook or any real roster/contract/metric data; tests use synthetic
  data only. (`*.xlsx` is git-ignored.)
- The writer touches only the `x-performance` tab — never the human roster/contract/monthly tabs, never
  cost columns.

## Open items to verify live (not blockers to planning)

- The roster tab name (`KOL list`) and the header labels (`KOL`, `Social media`, `Social media link`)
  must match the real workbook; header-name mapping mitigates column moves but a renamed tab/header
  needs the constants updated.
- advanced_search month-window cost per KOL (pagination) and the `MAX_PAGES` coverage cap for prolific
  accounts.
- Confirm `Social media` values in the real sheet (`X` vs `Twitter` vs `x.com`) so the X-filter matches.
