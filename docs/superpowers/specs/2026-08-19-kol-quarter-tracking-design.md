# The work sheet already knows how to add up — design

Date: 2026-08-19
Status: approved for planning
Scope: a weekly sweep that fills the per-post log of `2026 Q3 KR Work Sheet`'s monthly tabs for a
whole quarter, so the summary formulas the team already wrote produce each KOL's post count against
what their contract requires — and the roster consolidation that makes writing into a human tab safe.

Every structure below was read off the live workbook on 2026-08-19.

## The question this started from

> 2026 Q3 KR Work Sheet 도 자동화를 좀 하고싶거든. q3 등의 분기던, 현재 계약한 kol과 달마다
> kol쪽에서 나와야하는 글의 값이 주어지면. 일주일에 한번정도 스케쥴이 돌면서 몇개의 글의 나왔는지
> 트랙킹 하는거지. kol-map은 kol list에 통합될 수 있는거 아닌가?

## What the sheet already does, and the mistake worth recording

Each monthly tab (`Jul.`, `Aug.`, `Sep.`) is **two tables**, not one:

```
rows 1-8    summary, one row per KOL
rows 9-10   blank
row 11      log header
rows 12+    one row per post
```

The summary's numbers are **formulas over the log below it**:

| column | cell |
| --- | --- |
| `Posts` | `=COUNTIF(A11:A, "Raoni")` |
| `Views` | `=SUMIF($A$12:$A$1963, A2, $G$12:$G$1963)` |
| `Engagement` | `=SUMIF($A$12:$A$1963, A2, $H$12:$H$1963)` |
| `Total Cost` | `=SUMIF($A$12:$A$1963, A2, $J$12:$J$1963)` |
| `Avg.views`, `Engagement Rate`, `Impression Rate`, `Price per post`, `Cost Per Impression` | ratios of the above |

`followers` is the only human-entered value in the summary block.

**The first design proposed for this feature was to write `Posts`/`Views`/`Engagement` directly.** It
was wrong: those cells are formulas, and writing values into them would have destroyed the rollup the
team maintains. The error came from reading `#DIV/0!` as "empty" instead of "a formula dividing by
zero" — worth recording because the mistake is invisible through the values API, which returns
`#DIV/0!` for a formula and `""` for a blank and nothing else. Reading with
`valueRenderOption=FORMULA` is what settles it, and any future writer aimed at this workbook should
do that before assuming a cell is free.

## The log region is `kol-telegram-posts` under different names

| log header (row 11) | `kol-telegram-posts` | who owns it |
| --- | --- | --- |
| `KOL` | `kolId`, via `sheetLabel` | machine |
| `Social` / `Social media platform` | — (constant `Telegram`) | machine |
| `Posting date` | `postedAt` | machine |
| `Deliverable Link` | `deliverableLink` | machine |
| `Topic` | `topic` | **human**, never written (amended — see below) |
| `Content Views` | `views` | machine |
| `Engagements` | `engagements` | machine |
| `Engagement Rate` | — | formula `=G12/F12` |
| `Price per posting` | `pricePerPost` | machine |
| `Cost per impression` | — | formula `=I12/F12` |
| `Organic` | — | **human**, never written |
| `Duplicated?` | — | formula `=COUNTIF(D:D,D12)` |

So the sweep's job is to fill **seven value columns** of the log — `Topic` included in an earlier
draft, and amended out of scope below. Every number the request asked for
falls out of formulas that already exist. **The summary block is never written.**

## Decisions

### 1. The machine writes values only, never a formula and never a date

`GoogleSheetClient` hardcodes `valueInputOption=RAW` in all three of its write methods
(`GoogleSheetClient.ts:120,131,146`). Under `RAW`, a string beginning with `=` is stored as literal
text, not a formula — so a values-API writer *cannot* produce the three formula columns even if it
wanted to. Rather than widen the client to `USER_ENTERED` (which would let every future caller write
a formula into a human tab by accident), the formulas are **filled down once, by hand, as migration**
— they are per-row and identical in shape — and the weekly writer only ever writes plain values into
rows whose formulas already exist.

This supersedes an earlier decision to have the writer emit those three formulas per row. Filling
them once is less machinery and strictly narrows what the machine can do to this workbook, which is
the property that makes writing into it defensible at all.

`Posting date` is written as a **Sheets date serial** — an integer, days since 1899-12-30, verified
against the live cell (`2026-07-03` → `46206`). A number is `RAW`-safe where a date string is not:
`RAW` would store `"2026-07-03"` as text in a column of real dates. The migration extends the
column's number format down the log region so a serial renders as `07/03/26` like its neighbours.

### 2. `kol-map` retires into `KOL list`, and `tgHandle` needs no new column

`KOL list` already has an empty `Social media link` column (L), and `LoadKolMap` already accepts four
handle spellings — `https://t.me/<h>`, `t.me/<h>`, `@<h>`, bare `<h>` (`LoadKolMap.ts:86`, via
`extractTelegramHandle`). The telegram address column the request asked for is already there and
unused; the handle is read from it.

Four columns are genuinely new, appended after `Note` (M):

| column | why it cannot be derived |
| --- | --- |
| `kolId` | `kol-telegram-posts` rows are already keyed by it; changing the key would orphan 31 rows |
| `sheetLabel` | the monthly tabs' `KOL` column is a fourth spelling of each name — see below |
| `pricePerPost` | `Content Price` is free text (`150~180`, `0.01`) and not machine-usable |
| `active` | the "In contract" grouping in `KOL list` is layout, not data; layout is not a predicate |

`Content Price` and `pricePerPost` **both stay**. They disagree — Marine is `150` in one and `100`
in the other — because they measure different things (a negotiation figure versus contract price ÷
required posts). Merging them would fabricate an agreement that does not exist.

`kol-map` is **not deleted**. Its row 1 is marked retired and the code stops reading it, so the
migration is reversible by anyone who disagrees with how a row was placed.

### 3. The log header is found, not assumed — and it is not spelled the same twice

Two things must be located rather than hardcoded, both discovered while writing this spec:

- **The header row.** It is row 11 in all three tabs today, but the summary block above it grows when
  a KOL is added to the roster. The writer finds the log header by scanning column A for the row
  whose cells match the log's own header names, and refuses if it finds none.
- **`Social` vs `Social media platform`.** `Jul.` column B is headed `Social`; `Aug.` and `Sep.` say
  `Social media platform`. Same column, same constant value (`Telegram`), two spellings. The writer
  accepts either — a set of accepted spellings per logical column, not one literal — because
  normalising the humans' headers would be this design editing a tab it has no reason to touch. The
  accepted-spellings set is the one place a future divergence gets added.

Neither is a place to guess: a mis-located header row would write a post's data on top of the
summary block.

### 4. One KOL, four names — and why the log dodges the problem

| contract list | `KOL list` | monthly tabs | `kolId` | handle |
| --- | --- | --- | --- | --- |
| Marine | Marshall | Marine | `marine` | `marshallog` |
| Enjoy hobby | Enjoymyhobby | Enjoyhobby | `enjoyhobby` | `enjoymyhobby` |
| CEK | Cek | CEK | `cek` | `airdr0p_lab` |
| Leedogin | leedojin | *(absent)* | `leedogin` | `leedogin2` |

The log region is keyed on **`Deliverable Link`**, not on a name: the sheet's own `Duplicated?`
formula (`=COUNTIF(D:D,D12)`) already treats that column as the unique key, and
`kol-telegram-posts` upserts by the same permalink. So the name mismatch cannot corrupt a write —
it only decides which `sheetLabel` goes in column A, and an unresolvable one is reported rather
than guessed.

### 5. Required post counts are parsed, and nothing depends on the parse

` Q3 KOL 계약 리스트` carries per-month blocks:

```
July | KOL | Deliverables | Price | Contract Status | Tx
     | Marine      | Monthly (10)        | 1000 | Soloved | 0x97c0…
     | Raoni       | Monthly (unlimited) |  900 | Soloved | …
     | GMB         | TG (8)              |  600 | Non soloved
```

`Deliverables` parses to one of three outcomes: **a number**, **unlimited** (a real state, not a
failure), or **unreadable**. The count is read **only to compare against** in the run's report —
never written to a cell. A parse that fails therefore degrades to "target unknown for this KOL" and
the measured count is still reported, matching how `glossary:mine` degrades when its corpus is
missing rather than failing the run.

The block *layout* is the riskier half — month-name header rows, blank separators, a leading blank
column. Parsing anchors on the month-name header row; if the layout does not match, the run
**refuses rather than mis-attributing** a count to the wrong month.

### 6. The sweep covers the whole quarter, every week

`pnpm kol:quarter [--quarter 2026-Q3]`, on a weekly timer (a seventh unit, `herald-kol-weekly`,
following `herald-translate-check.timer`'s shape and its `OnFailure=` ops alert).

`Posts` is a month-to-date count, not a delta, so a week-scoped sweep cannot produce it: a KOL who
posts late in a month would be undercounted permanently. Sweeping all three months makes every run
idempotent and self-healing, which is the same reason `x:reconcile` re-reads its whole window.

No new scraper. `kol-telegram:record`'s existing per-month sweep refreshes `kol-telegram-posts`;
this command runs it for each month of the quarter and then projects those rows into the month's
log region.

### 7. Non-goals

- **The summary block, including `followers`.** An earlier draft put `followers` in scope because the
  t.me preview page carries a subscriber count the parser does not extract. It is out: the summary
  block stays entirely human-owned, and adding a machine column to it would reopen exactly the
  boundary this design closes. Extracting subscribers is a separate change if anyone wants it.
- **`Total Cost` and every ratio.** Formulas, and they already work.
- **Deleting `kol-map`.** Retired in place.
- **X KOLs.** `metrics:record` already covers the X side into `x-performance`; this is the Telegram
  log.
- **Tab order.** The human tabs already sit left of the machine tabs (indices 0-4 against 5-8). The
  only ordering change is `kol-map` becoming retired, and inventing a reshuffle would be work
  without a reason.

## Migration, done once

1. Copy `kol-map`'s 13 rows into `KOL list`'s four new columns, matching on the handle in
   `Social media link` **first** and, only for a row no handle placed, on a normalised name
   (`normalizeKolName` over `sheetLabel` then `kolId`, against `KOL list`'s `KOL` column — the same
   fold §4's contract join uses); write the handle into `Social media link` where it is blank.
   Report every row that cannot be placed — six have no `sheetLabel`, and some of those name KOLs
   absent from the monthly tabs entirely.

   The name fallback is not optional dressing: `Social media link` is blank on **all 63 live rows**,
   so a handle-only join places 0 of 13 and leaves `LoadKolMap` returning `[]` — an empty roster
   that both `kol:quarter` and `kol-telegram:record` sweep silently. It is safe *here* and nowhere
   else in this design because this step previews and a human reads every proposed placement before
   `--yes` writes anything; the preview names the key each row matched on, so a wrong name match is
   something a reader can catch. `"Marine"`/`"Marshall"` must stay unmatched — the fold is
   case/whitespace only, never fuzzy.
2. Fill the three formula columns and the `Posting date` number format down the log region of each
   monthly tab, to the row the summary's `SUMIF` already reaches (`1963`).
3. Mark `kol-map` row 1 retired.

Steps 1 and 3 are scripted and reversible. Step 2 is a formatting change a human should eyeball once
per tab.

## Testing

- The contract-list parser: a number, `unlimited`, an unreadable value, a layout that does not match
  (must refuse), and a month block that is present but empty.
- The date serial, against the live value this spec quotes: `2026-07-03` → `46206`.
- Roster resolution: a monthly-tab row whose label resolves, one that does not (left alone,
  reported), and a KOL with no handle (not swept).
- The projection: a post already in the log is updated in place by `Deliverable Link`, `Topic` and
  `Organic` survive a refresh, and no cell outside the seven value columns is written — the last one
  asserted by capturing every range the writer sends (the seven, and never `Topic`).
- The append point: a log whose formula columns have been filled down (so blank rows read back as
  `#DIV/0!`, not `""`) still appends directly under the last row carrying a `Deliverable Link`; and
  a log whose rows reach 1963 refuses to allocate another rather than overwriting 1963 or writing
  1964.
- A post a human marked `reject` in `kol-telegram-posts` reaches neither the log nor the contract
  count.
- The log's `Price per posting` comes from the recorded row's own `pricePerPost`, and only falls
  back to the roster's rate when that row carries none.
- Idempotence: two consecutive runs produce identical cells.

## Risk

**The machine now writes into a workbook the team edits by hand**, which no part of this pipeline did
before. The mitigation is that its write surface is a declared allowlist — seven value columns — addressed
**by header name**, and the writer refuses to run when an expected header is missing or has moved
rather than writing to a guessed column index — the rule `RecordKolTelegramPosts` already follows.
The failure this prevents is the one that would be least visible: a column inserted by a human
shifting every subsequent write one cell to the right, silently, into cells holding someone's
formulas.

## Amendment — 2026-08-19, after the final whole-branch review

Three things this document said that the shipped code deliberately does not do. The code's choice is
the safer one in each case, so the spec is amended to it rather than the code being bent back.

### `Topic` is never written, not "backfilled while blank"

The mapping table above originally gave `Topic` to the machine on a blank-only basis, and the
Testing section asked for a range assertion that allowed it. `logCells`
(`src/domain/kol/monthlyLog.ts`) emits the seven value columns and nothing else, and a test pins
that column E is never inside any range the projection sends.

Why the narrower rule is right: **a human-owned column in a human tab is not the machine's to
backfill.** The blank-only `topic` backfill that does exist belongs to `kol-telegram-posts` — a
machine-owned tab, where a blank cell means "the machine has not filled this yet" and the human's
own verdict lives in a different column (`confirmed`). In the monthly log there is no such
separation: `Topic` is free text the team writes about their own deliverable, in a tab they edit
while this command is running, and "blank" there means "nobody has written it yet", which is a
statement about a person's work, not about a pipeline's progress. Keeping the write surface at
exactly seven columns also keeps the §Risk mitigation a flat allowlist with no conditional member —
the one property that makes writing into this workbook defensible at all.

### The append point is found from `Deliverable Link`, and clamped to row 1963

Migration step 2 (fill the three formula columns down to 1963) and an append point computed as "the
last row where any cell is non-empty" cannot both be right: `getValues` sends no
`valueRenderOption`, so a filled-down formula over blank inputs reads back as `#DIV/0!` rather than
`""`, and every filled row looks used. The first run after the required migration would have
appended at 1964 — counted by `Posts` (`=COUNTIF(A11:A, …)`, open-ended) and invisible to
`Views`/`Engagement`/`Total Cost` (`SUMIF($A$12:$A$1963, …)`).

So the writer finds the append point from the log's **own key column** — the same `Deliverable Link`
the sheet's `Duplicated?` formula treats as the key — and **row 1963 is a hard ceiling**
(`LOG_LAST_ROW`). When the log is genuinely full at 1963 the run refreshes the rows that already
exist, writes no new row, reports every post it could not place, and **exits non-zero** so the
weekly timer's `OnFailure=` fires. It never overwrites row 1963 and never writes 1964: a full log is
a thing for a human to decide about (extend the summary formulas' range, or archive the tab), and
both silent alternatives corrupt a number the team invoices from.

### A rejected post is neither logged nor billed

`confirmed = "reject"` was already a real policy in `RecordKolTelegramPosts` (it refuses to refresh
a rejected row, and refuses it as a source of an inherited topic) but nothing downstream read it, so
the projection wrote the rejected post into the monthly log with its price and the contract
comparison credited it — and a human deleting the log row got it re-appended the next Tuesday, since
the link then looked unknown. The sweep now filters on the same shared predicate (`isRejected`)
before projecting and before counting, so `reject` is the human's undo.

Relatedly, the log's `Price per posting` is taken from the recorded row's own `pricePerPost` and
falls back to the roster's rate only when that row carries none — the mapping table above always
said `Price per posting` ← `kol-telegram-posts.pricePerPost`, and re-deriving it from the live
roster would have reverted a human's per-row correction weekly and retro-priced months already
invoiced whenever a rate changed in `KOL list`.
