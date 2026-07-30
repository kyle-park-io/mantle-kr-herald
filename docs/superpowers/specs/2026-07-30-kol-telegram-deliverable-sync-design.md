# KOL Telegram deliverable sync — design

Date: 2026-07-30
Status: awaiting approval

## Context

The X performance tracker spec (`2026-07-27-x-performance-tracker-design.md`) drew a boundary and
left one thing explicitly outside it: *"Telegram-based KOLs' metrics (twitterapi.io is X-only)"* were
listed as **not automatable**. This sub-project closes that gap.

`GSHEET_ID` already points at the team's live **2026 Q3 KR Work Sheet**. Verified tabs:

```
 Q3 KOL 계약 리스트   (note the leading space in the tab name)
Jul.  Aug.  Sep.
KOL list
x-performance        (machine-owned, written by metrics:record)
history              (machine-owned)
```

So no new environment variable is needed — the workbook this feature writes into is the one the
pipeline is already configured for.

Each monthly tab holds two blocks. Rows 2–8 are a per-KOL summary of formulas. Row 11 is the header
of a per-post table, and those rows are what a human fills by hand today:

```
A KOL | B Social | C Posting date | D "Deliverable Link " | E Topic | F Content Views
G Engagements | H Engagement Rate | I Price per posting | J Cost per impression
K Organic | L Duplicated?
```

(Column D's header carries a trailing space in the live sheet.) `Jul.` currently has 18 filled rows
across three KOLs; `Aug.` and `Sep.` are empty. The rows are posts KOLs made in **their own**
Telegram channels, not sends from our pipeline, so nothing in the existing publish ledger covers
them.

## Verified evidence

Every claim below was measured against the live sheet and live Telegram before writing this spec.

**The public channel preview exposes everything the table needs.** `GET https://t.me/s/<handle>`
returns, per post: `data-post="<handle>/<n>"` (permalink), an ISO `datetime`, a view count, per-emoji
reaction counts, and the post text. `?before=<n>` pages backwards.

**Engagements is the sum of reaction counts.** Cross-checked three rows already in `Jul.`:

| Sheet row | Sheet recorded | Measured 2026-07-30 |
| --- | --- | --- |
| `marshallog/22794` | views 2800, engagements 3 | views 2.93K, 👍2 + ❤1 = **3** |
| `Raoni1/20914` | views 2000, engagements 0 | views 2.1K, no reactions = **0** |
| `enjoymyhobby/96560` | views 3700, engagements 8 | views 3.8K, ❤**7** |

The third row differs by one because a reaction was withdrawn between the two readings. Reactions are
revocable and views only grow, which is the entire argument for recording `fetchedAt` per row.

**View precision is sufficient.** Counts under 1,000 come back exact (`879`, `704` observed); above
1,000 they are rounded to three significant figures (`2.93K`). The values a human has already typed
into the sheet are rounded to the nearest hundred (`2800`, `3700`), so scraping loses no precision
that the current process preserves.

**Follower counts are not usable.** The preview reports `22.2K` subscribers for `marshallog`, while
the sheet's `followers` column holds `23739`. Rounded, and already stale. Out of scope (see
Non-goals).

## Decisions

### 1. Source: public `t.me/s/` preview, no new credentials

Three options were considered.

- **Telegram Bot API** — rejected. It does not expose channel message view counts at all, and would
  require our bot to be made an admin of each KOL's channel.
- **MTProto user session** (GramJS) — deferred. Free of charge, and it yields exact view counts,
  exact subscriber counts, forwards, and comment counts. The cost is not money: it authenticates as a
  *person*, so a phone-number session string must be stored, and that string carries full authority
  over that account, including every private conversation it can see. It also risks account
  restriction and `FLOOD_WAIT` throttling. Revisit only if exact follower tracking or
  comment/forward metrics become requirements.
- **Public preview scrape** — chosen. Adds zero credentials, needs no KOL cooperation, and as shown
  above already matches the precision the sheet is maintained at.

### 2. `TelegramChannelGateway` port, mirroring the X side

The shape follows `metrics:record` exactly: where that pipeline has `SourceGateway` ↔
`TwitterApiSourceGateway`, this one has `TelegramChannelGateway` ↔ `TmePreviewGateway`. The gateway
takes a handle and a month window and returns raw posts only:

```ts
interface ChannelPost {
  handle: string;
  messageId: number;
  url: string;           // https://t.me/<handle>/<messageId>
  postedAt: string;      // ISO
  views: number;
  reactions: { emoji: string; count: number }[];
  text: string;
}
```

It makes no judgement about relevance, price, or attribution. All HTML parsing is confined to the
adapter, so a Telegram markup change can only break one file.

### 3. `kol-map`: one machine-readable KOL registry

The workbook spells the same KOL four different ways — `Marine` / `Marshall` / `marshallog`,
`Enjoyhobby` / `Enjoy hobby` / `Enjoymyhobby`, `leedogin` / `leedojin`, `Cek` / `CEK`. This is the
single largest blocker to automation, and no amount of fuzzy matching in code is an acceptable
substitute for a declared mapping.

A new human-maintained tab, `kol-map` (English name, consistent with `targets` and `history`):

```
kolId | tgHandle | sheetLabel | pricePerPost | active
```

`sheetLabel` is the spelling used in the monthly tabs' column A, so generated rows join to the
existing summary formulas without editing them. Handles are seeded from the `Q3 조정 단가 표` block's
link column — 13 channels: `enjoymyhobby`, `GMBLABS`, `Raoni1`, `airdr0p_lab`, `marshallog`,
`murphybus`, `leedogin2`, `coinboys`, `Bounty_ATM`, `waitstudy`, `WeCryptoTogether`, `BQTelegram`,
`CRYPTOSCH00L`. Two of those cells contain stray whitespace (`airdr0p_lab ` and ` marshallog`), so
handles are trimmed on read.

That rate table is deliberately broader than the contract list — July contracted only seven KOLs,
while the table prices thirteen. Sweeping all thirteen is what surfaces unpaid Mantle coverage for the
`organic` verdict; `active` in `kol-map` exists to drop a channel from the sweep without deleting its
row.

**Accepted trade-off:** `pricePerPost` now exists both here and in the 단가 표. Reading the 단가 표
directly was rejected because it is a free-form human block at rows 29–42 that moves when someone
inserts a row, and a silently shifted price is worse than a visible duplicate. The duplicate is
mitigated by surfacing the price as a *suggestion* the human confirms. Note the sheet already
disagrees with itself here: the 단가 표 says Enjoyhobby is `62.5`, while the July rows say `63`. The
code will carry `62.5` through unrounded.

### 4. Two-stage detection: wide candidate net, suggested attribution

**Stage 1 — candidates.** Any post in the month window whose text matches `맨틀`, `mantle`, or `MNT`
(word-boundary matched, so `MNT` does not fire inside unrelated words). Deliberately wide: output
lands in a review tab, so a false positive costs one human keystroke while a miss costs a missed
payment obligation.

**Stage 2 — attribution, as a suggestion only.** The candidate's text is compared against approved
Telegram-channel renderings in `output/formatted/renderings.json`, which carry `itemId` and the exact
Korean copy the pipeline produced. Similarity is character 3-gram Jaccard over text normalized to
strip whitespace, emoji, and URLs — KOLs rewrite copy in their own voice and reorder lines, so a
token-set measure survives that where an edit-distance ratio does not. The best match's `itemId` and
its score land in `matchScore` (0–1); below **0.30** both are left blank rather than guessed. The
machine never decides paid-vs-organic; that is the human's column.

**Attribution does not work for a July backfill, and that is acceptable.** The earliest rendering in
any local snapshot is `2026-07-21`, because the pipeline was still being built before that, while the
existing July KOL posts run `07-03`–`07-19`. So for July, `itemId`, `matchScore`, and `topic` come
back blank and a human labels topics — which is what already happened by hand. Every other column is
unaffected, and attribution works from August onward. The threshold above is therefore an initial
value to be calibrated on the first real August run, not a tuned one.

**What the live dry-run measured, and what it did not.** Before this feature shipped, a dry run
scored eight real KOL posts against our approved copy and got scores of `0.0023`–`0.0177`, all far
below `MATCH_THRESHOLD` (0.30). Read on its own that result looks like reassuring evidence that the
threshold is conservative and could safely be lowered. It is not that. The only approved Telegram
rendering available to match against at the time was approved on `2026-07-29`, and all eight
candidate posts were published `07-03`–`07-22`, before that rendering existed, on an unrelated topic.
By construction, none of the eight could possibly match — the sample contains **zero true positives**.
What the run measured is that eight guaranteed true negatives were correctly rejected, which the
threshold was always going to do at any reasonable value. It says nothing about **threshold
sensitivity** — whether a genuine KOL rewrite of our copy would still clear 0.30 — because no true
positive was present to test that. **`MATCH_THRESHOLD` must not be changed on the strength of this
run.** Calibrating it needs a case where the candidate and the rendering both come from the same
campaign, which only exists from August onward (per the paragraph above).

**Topic bootstraps itself.** In `Jul.`, the same Topic string repeats across every KOL row for one
campaign (`USPXx Live on Mantle` appears three times), which shows Topic is a label per *content
item*, not per post. So once a human types a topic for an `itemId` in the review tab, every later row
resolving to that `itemId` inherits it automatically. One entry per campaign instead of one per KOL
post. No separate topic tab is needed.

### 5. `kol-telegram-posts`: machine-owned review tab, per post

Written into the same workbook, alongside `x-performance` and `history`:

```
kolId | tgHandle | postedAt | deliverableLink | views | engagements | reactionsDetail
itemId | topic | matchScore | pricePerPost | fetchedAt | confirmed
```

`itemId`, `topic`, `matchScore`, and `pricePerPost` are machine *suggestions* that a human may
overwrite; the rest are machine-owned readings.

- `deliverableLink` is the row identity — a Telegram permalink is immutable and unique.
- `reactionsDetail` (`👍2 ❤1`) is the human-auditable evidence behind `engagements`.
- `fetchedAt` is when *these* numbers were read. Without it, comparing KOLs compares a one-day-old
  number against a thirty-day-old one. The publish ledger already carries `impressionsAt` for the
  same reason.
- `confirmed` is the only column a human writes: blank, `paid`, `organic`, or `reject`.

### 6. Idempotency: the machine never overwrites a human

Re-running upserts by `deliverableLink`. On an existing row, only `views`, `engagements`,
`reactionsDetail`, and `fetchedAt` are refreshed. `confirmed`, and any `topic` a human has edited,
are never overwritten. Rows marked `reject` are not re-proposed on later runs.

### 7. Error isolation per channel

A channel that goes private, gets deleted, or is renamed simply has no preview. That channel is
skipped with a warning and the run continues — the same per-account isolation `metrics:record` uses.
The run summary must state how many of the 13 channels were unreachable, so a silent zero is never
mistaken for "no posts this month".

### 8. The machine does not write the monthly tabs

Code stops at `kol-telegram-posts`. A human moves confirmed rows into `Jul.`/`Aug.`/`Sep.`. This
matches the repository's standing rule that the agent prepares and renders but never approves.

## Non-goals

- **Follower counts.** The preview only rounds them (§1).
- **Comment and forward counts.** Not in the preview; would require MTProto.
- **Writing the monthly tabs, the contract list, or `KOL list`.** Business and relationship facts stay
  human-owned.
- **Repairing the summary formulas by code.** See the appendix — those are human edits.

## Testing

- **Parser contract, locked to fixtures.** Real captured `t.me/s/` HTML is committed as a fixture so a
  Telegram markup change breaks a test before it breaks a run. The three cross-checked posts from
  *Verified evidence* become the regression cases: `22794` → 3 engagements, `20914` → 0, `96560`.
- **Precision boundary.** A sub-1,000 exact count and a `2.93K` rounded count both parse correctly.
- **Detection.** A post containing `맨틀` is a candidate; a post containing `moment` is not (guards the
  `MNT` word boundary); an off-window post is excluded.
- **Idempotency.** Two consecutive runs over the same fixture leave `confirmed` and a
  human-edited `topic` untouched while `fetchedAt` advances.
- **Topic inheritance.** A second row resolving to an already-labelled `itemId` inherits its topic.
- **Channel isolation.** One unreachable handle out of three still yields the other two's rows plus a
  warning, and the summary reports the skip.

## Appendix — sheet defects for a human to fix

Confirmed present in the live sheet on 2026-07-30, not just in the downloaded copy. These are outside
the code's scope but the per-post rows this feature generates feed the broken summary block, so they
should be fixed alongside it.

**Re-confirmed against the live sheet on 2026-07-30.** The four defects below are still present
exactly as described. A fifth defect previously listed here — a stray `G10` cell holding `=75*8` — is
no longer present; someone cleaned it up between the original check and this re-check, so it has been
removed from this list.

**The summary block's SUMIFs reference the wrong columns.** Correct targets are F (Content Views),
G (Engagements), I (Price per posting).

| Cell | Live formula | Sums | Should sum |
| --- | --- | --- | --- |
| `D2`, `D4`–`D8` (Views) | `SUMIF(…, $G$12:$G$1963)` | Engagements | `$F$` |
| `F2`–`F8` (Engagement) | `SUMIF(…, $H$12:$H$1963)` | Engagement *Rate* | `$G$` |
| `J2`–`J8` (Total Cost) | `SUMIF(…, $J$12:$J$1963)` | Cost per impression | `$I$` |

`D3` (Marine) is the sole correct Views cell, which is why only Marine's `12600` looks plausible while
Raoni reads `4` and Enjoyhobby reads `50` — those are their engagement sums. Actual July views are
10,800 and 25,400. Everything derived downstream — Avg.views, Engagement Rate, Impression Rate, Total
Cost, Price per post, Cost Per Impression — is wrong for every KOL. Marine's Total Cost reads `0.295`
where six posts at `100` should give `600`. The same pattern is copied into all three monthly tabs.

**`Aug.`/`Sep.` C5 counts the wrong KOL.** Coinboy's row reads
`COUNTIF(A11:A, "Enjoyhobby")` — a copy-paste error, so Coinboy would report Enjoyhobby's post count.

**`COUNTIF(A11:A, …)` includes header row 11.** Harmless today (no KOL is named `KOL`), but
inconsistent with the sibling `SUMIF`s, which start at row 12. Start at `A12`.

**The budget row overstates spend.** In ` Q3 KOL 계약 리스트`, `Current Expense` is
`=sum(D4:D29)`, a range spanning the July, August *and* September price blocks. `Remained` therefore
shows `0` on a `10000` budget while only two rows carry a payout Tx. It is measuring committed
amounts, not spend. Split into per-month subtotals, or restrict the range to rows with a settled
contract status.
