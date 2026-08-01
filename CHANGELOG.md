# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Upgrading — action required for existing installs

- **Set `DATABASE_URL` and `HERALD_DB_ENV` (`development` or `production`) in `.env`, then run
  `pnpm db:import` once, before the first send after upgrading.** The record of truth — translations,
  variants, renderings, outlet overrides, both send ledgers, publish state, lineage, few-shot
  examples, and collected X/Lark content — moved from `output/*.json` files to Postgres. Every CLI
  command and the dashboard now read and write through the database, not the tree; `output/` is no
  longer where sent state lives. `pnpm db:import` applies the database schema itself the first time
  it runs (there is no separate migration step to remember), then copies whatever `output/` (and
  `translation/`/`conversion/`'s few-shot corpora) currently holds into the database once; it only
  ever upserts or appends and never deletes, so re-running it is safe as long as the tree hasn't
  drifted since — re-running it against a tree that *has* since gone stale can resurrect a row
  removed through the app, so it is meant to run once at cutover, not routinely. Skipping this step
  is not a silent failure: `pnpm serve`, `pnpm send:channels`, and `pnpm send:x-article` all refuse
  to start or send when the database's delivery (or X-article) ledger is empty but
  `output/publish/deliveries.json` / `channels.json` (or `x-article.json`) still holds sent rows on
  disk, and say to run `pnpm db:import` — the unguarded alternative would have been every
  already-sent item reading as never-sent, and the next send re-posting the whole history to live
  Telegram rooms and the brand's X account. `pnpm doctor` now checks the database connection too
  (host and database name only, never the password) by querying a real table, so a database that
  connects but was never imported into fails the check instead of reporting healthy, and `pnpm
  status` prints the attached environment on its first line.
- **`pnpm db:export` (the rollback path) now previews by default and requires `--yes` to write, the
  same shape as `pnpm db:import`.** A flagless run only prints current-on-disk-vs-incoming-from-
  database counts for every store; nothing is written until `--yes` is passed. It also refuses
  outright — even with `--yes` — to overwrite a store's file with an empty one when that file
  already holds rows on disk: an empty or wrong database (unset `HERALD_DB_ENV`, or one `db:import`
  was never run against) is a far more likely explanation than the store having been genuinely
  emptied, and `db:export`'s default target is the same `output/` tree that is both `db:import`'s
  only input and the send-path ledger guard's only safety net. Pass `--allow-empty-overwrite` if a
  store really was emptied and the export is meant to reflect that.
- **Before the first `pnpm kol-telegram:record`, create and seed the `kol-map` tab by hand — the
  command cannot run without it, and the rows it writes decide KOL payments.** This is a new
  human-maintained tab in the `GSHEET_ID` workbook with the header row
  `kolId | tgHandle | sheetLabel | pricePerPost | active`. **Paste the table already prepared in
  [`docs/ko/kol-map-seed.md`](docs/ko/kol-map-seed.md) rather than retyping from the `Q3 조정 단가 표`
  block**, because two things in that block cannot be copied at face value: the sheet *displays*
  `$63` for Enjoyhobby where the real rate is **`62.5`** (a rounded currency format — paste `63` and
  every one of that KOL's rows carries a wrong price), and six of the thirteen channels have no
  `sheetLabel` established in any monthly tab yet, so the seed table leaves those blank on purpose
  rather than guessing a spelling that would silently break the `SUMIF`/`COUNTIF` join. If the tab is
  missing the command now says so and points at that document, instead of the raw
  `Sheets getValues failed: HTTP 400` it used to fail with.
- **`active` in the seed table is blank for every row, which means a fresh paste sweeps nothing.**
  That is deliberate — the rate table prices thirteen channels while only seven were contracted for
  July, and which channels to sweep is a contract decision. Write `true` into `active` for the
  channels currently under contract. A run that swept no channel now warns loudly rather than
  printing five zeroes that look like a clean month.
- **`tgHandle` accepts a URL or a bare handle, in any casing.** All of `https://t.me/marshallog`,
  `t.me/marshallog`, `@marshallog`, and `marshallog` work, and `raoni1` finds `Raoni1`. A cell that
  cannot be read is reported with its sheet row number and the KOL's id, and only that channel drops
  out of the sweep. A currency-formatted rate (`$100.00`, `₩100`, `US$1,100`) is read as a number; a
  rate that cannot be read is warned about and written **blank** rather than `0`, so fixing the cell
  and re-running still repairs those rows.
- **`kol-telegram-posts` is machine-owned, but `confirmed` is yours and the machine now provably
  cannot reach it.** Fill `confirmed` with `paid`, `organic`, or `reject` as you review, and move
  confirmed rows into `Jul.`/`Aug.`/`Sep.` yourself — there is no automatic transfer. You can edit
  the tab **while a run is in progress** (a run takes minutes): a refresh writes only the cells whose
  values actually changed, so `pricePerPost` and `confirmed` are not inside any range it writes.
- **Read the summary line, not just the exit code.** `0 channel(s) swept` means nothing was read at
  all. A non-zero `channel(s) failed` includes channels that answered HTTP 200 but had no posts on
  the page — deleted, renamed, or preview-disabled. A non-zero `channel(s) truncated` on a past-month
  re-run means that channel was never reached, so the retroactive attribution did not happen for it.

### Added

- **The two read-only "원문" panes now show a hover preview for every photo marker.** A post's photos
  ride through the pipeline as `![](url)` markers inside the reviewed text (video as `[영상]`, which
  carries no url); 1차's `원문` pane (`TranslationDetail`) and 2차's `변환 원문` pane
  (`OutletCard > Source`) both render the marker's literal text unchanged and put the image one hover
  away, CSS-only, no new dependency. A failed image load shows "이미지를 불러오지 못했습니다" instead
  of a broken box. Each editing textarea that carries a marker (1차 한글, 2차 그룹/방 텍스트) gets a
  small notice below it — never inside the textarea itself, since a `<textarea>` cannot host a hover
  target on a substring — saying the preview lives in the pane beside it, and that video has no
  preview at all. See `web/src/components/MarkerText.tsx`, `web/src/media.ts` (a frontend-only mirror
  of `src/domain/media/sourceMedia.ts`'s marker regexes, kept honest by a test asserting the two stay
  byte-for-byte identical) and
  `docs/superpowers/specs/2026-07-30-dashboard-media-preview-design.md`.
- **`pnpm kol-telegram:record [--month YYYY-MM]` — Telegram KOL deliverable sync.** Reads the active
  rows of the new human-maintained `kol-map` tab, sweeps each KOL's public Telegram channel preview
  (`https://t.me/s/<handle>`, no API key and no bot token — it is a public web page) across the
  month, keeps posts mentioning `맨틀`/`mantle`/`MNT`, suggests an attribution against approved
  Telegram renderings, and upserts one row per post into a new machine-owned `kol-telegram-posts`
  review tab keyed by the Telegram permalink. This closes the gap the X performance tracker left
  explicitly outside its boundary ("Telegram-based KOLs' metrics — twitterapi.io is X-only"). A human
  then marks each row `paid`/`organic`/`reject`. `cloud` storage mode only, like `metrics:record`.
  See [`docs/ko/capabilities.md`](docs/ko/capabilities.md) §9 and
  `docs/superpowers/specs/2026-07-30-kol-telegram-deliverable-sync-design.md`.
- **`SheetClient.batchUpdateValues` — many disjoint ranges in one Sheets request.** The API allows 60
  write requests per minute per user, and a month's sweep can produce ~200 rows; one request per row
  did not fit, and the 429 landed mid-run. Used by `kol-telegram:record`, which now buffers every
  write and flushes it as one append plus one batch update.

### Changed

- **Dashboard session lifetime cut from 12 hours to 2 hours.** Signing out
  (`POST /api/logout`) only ever cleared the cookie in the browser — the session token itself was
  never revoked, so a stolen-then-logged-out token stayed usable until it expired regardless. Rather
  than build a server-side revocation record, `SESSION_TTL_MS` (`src/domain/auth/session.ts`) now
  bounds that exposure window at 2 hours instead of 12. The cookie's `Max-Age` is derived from the
  same `SessionConfig.ttlMs` a caller passes to `verifySession`, so the two cannot drift; a test now
  pins that derivation to the constant rather than a copied literal.
- **`state:push` now backs up the reviewed text as well — seven files, not five.**
  `output/translations/translations.json` and `output/variants/variants.json` join the bundle. They
  were classed as derivable on the grounds that the pipeline can produce a translation and a
  conversion again, which conflates *a* file with *that* file: both hold text an agent wrote and a
  human then read and approved, so re-running yields different copy, non-deterministically, at the
  cost of another agent pass — and every 1차/2차 approval standing on the old text goes with it. The
  pipeline can redo the work; it cannot restore the artifact. `renderings.json` stays out and that is
  deliberate: `format` really does rebuild it from the variants, which is what the board's per-card
  `[포맷 다시]` runs. Restoring an older snapshot needs no migration — a file the snapshot predates is
  reported `유지` and left alone, and the closing summary says the tree is now mixed. The list is in
  pipeline order (translate → convert → format → send), because that is the order `state:pull`'s
  preview prints for an operator deciding what to overwrite.

### Fixed

- **A session expiring mid-edit no longer loses a reviewer's unsaved text.** Any 401 — including one
  from a save the reviewer just triggered — sends the browser to `#login` (`web/src/api.ts`'s
  `json()`). `web/src/main.tsx` used to swap `<App>` out for the sign-in screen on that redirect,
  unmounting every bit of component state under it, unsaved edit included. At the old 12-hour session
  lifetime this was theoretical; at the new 2-hour lifetime (see above) a reviewer mid-edit on a 2차
  rendering can realistically hit it. `<App>` now moved into `web/src/Root.tsx`, which hides it
  (`display:none`) instead of unmounting it while the sign-in overlay is up, and reveals the same
  instance — unsaved draft intact — once login succeeds; `App.tsx`'s hash-driven mode router got a
  matching fix so the `#login` pseudo-route does not itself flip the board away from whatever mode
  the reviewer had open. That same "never unmount, only hide" change had a corollary: `<App>`'s (and
  `RenderingsView`'s) data load only ever ran in a mount-only effect, so the far more common path
  through the same overlay — the first login of the day, from a cold dashboard with no session
  yet — 401'd once on that initial fetch and then never retried, leaving a populated board looking
  permanently empty ("해당하는 항목이 없습니다") after a successful login until a manual reload.
  `Root.tsx` now threads an `authEpoch`, incremented on every successful login, into both
  components' data-loading effects so a login — first-time or a mid-edit re-auth alike — always
  retries the fetch; verified against a real browser and a throwaway Postgres, both for the
  mid-edit-401 case and this cold-start one.
- **`GoogleSheetClient` retries 429/5xx and network errors** (three attempts, `1000 * 2^attempt`),
  mirroring the policy `HttpClient` already used. It previously threw on the first non-2xx, so a
  transient rate-limit or 503 failed the whole command. Shared by `metrics:record`,
  `impressions:record`, `history:record`, `targets:list`, `sheet:init` and the new command.

## [0.3.0] - 2026-07-30

### Upgrading — action required for existing installs

- **If your `.env` still uses `TELEGRAM_CHAT_ID`, move it now — if you don't, Telegram delivery
  stops silently.** Copy that value into `TELEGRAM_CHAT_ID_COMMUNITY` (맨틀 한국 커뮤니티) and delete the
  old line. If you use the dev room, fill in `TELEGRAM_CHAT_ID_DEV` too. To check, read the summary
  line of `pnpm send:channels --target telegram` — an unconfigured room appears there as
  `· 미설정 N (TELEGRAM_CHAT_ID_DEV)`, named, not just counted.
- **The board may show more `발송 · 잠김` (send · locked) than before — most of it is correct.** Sending
  now checks the source translation's approval too, so a room hanging off a translation whose
  approval was withdrawn, or off one that **was approved again after the copy was**, is locked from
  now on. The yellow text under the row tells you which of the two it is; read it, and if it looks
  fine, press `승인 ✓` again and it releases. Nothing gets deleted. That said, if you have **older
  approved renderings or forks with no `approvedAt`** — the approval times cannot be compared, so
  they lock with `원문이 이 문구를 승인한 뒤에 다시 승인됐습니다` ("the source was approved again after this copy was").
  Here too the fix is nothing more than one `승인 ✓`.
- **An install that skipped the outlet axis (PR #80) and came straight up from a version predating
  it will show 맨틀 한국 데브방 as wholly "never sent to" the first time the dashboard is opened.** When
  `output/publish/deliveries.json` is absent the ledger migrates the old `channels.json` read-only,
  and an old row carries no room information, so it is attributed to **a single representative room
  for the channel** (`telegram` → 맨틀 한국 커뮤니티). So **every past item that has ever gone out over
  Telegram is marked unsent on the dev-room row** — the approval state is unchanged, so the row is
  not locked either, and one confirmation dialog puts a post from months ago into a live room.
  `send:channels`' first-delivery guard is no help here: **naming a room is itself the
  confirmation**, so the board's per-room `발송` lifts that guard by design. Before first use, either
  fill the past deliveries the dev room actually received into `deliveries.json` (one row per past
  item — `{"itemId","type","outletId":"tg-dev","status":"sent","at":"<ISO>","by":"auto"}`; written as
  `sent` it also reads as `발송됨` on the board and cannot be pressed again), or at the very least
  **tell the team not to press the dev-room row on past items**. An install that already came
  through PR #80 and has a `deliveries.json` is unaffected.
- **Run `pnpm state:push` once — the files you have been backing up by hand are this command's job
  now.** Copy forked per room (`✎따로`) exists only in `output/formatted/overrides.json` and cannot be
  produced again — if that file disappears, every room that had forked quietly reverts to the group
  copy, and not one error shows on screen. The same holds for the send ledgers
  (`output/publish/deliveries.json`, the older-format `channels.json`, `x-article.json`) and the
  sync ledger (`output/publish/state.json`). `state:push`/`state:pull` in `Added` below bundle these
  into a Drive snapshot.
- **On the first `pnpm send:reconcile` after the upgrade (or on the background check the dashboard
  runs every 2 minutes), a row that read `발송됨` (sent) may turn into `예약 취소됨` — that is data being
  corrected, not data disappearing.** An X send goes into the Typefully queue as a scheduled draft,
  and if that draft is deleted before it publishes, **nothing goes up in that room at all**. Until
  now a row like that stayed `발송됨` anyway. Now, when the check confirms the draft is gone, it
  changes only that row's status to `dropped` — the row itself stays in `deliveries.json`, and
  `postId` and the timestamp are preserved too (you have to be able to match which draft it was
  against the Typefully record later). On screen it takes the `예약 취소됨` badge, and that room becomes
  **sendable again**.
- **⚠ As a consequence of the item above, the idempotence the docs have been promising is no longer
  unconditional — an existing install with a backlog of approved items should check the board once
  before its first batch run after the upgrade.** Up to now
  [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §2,
  [`docs/ko/capabilities.md`](docs/ko/capabilities.md) §8, and
  [`docs/ko/setup/channels.md`](docs/ko/setup/channels.md) §"함께 검증 / 참고" have all said "an
  already-sent item is filtered out by the local ledger, so a rerun is always safe (idempotent)".
  Now **a row that has fallen back to `예약 취소됨` makes that room sendable again** — that is the
  purpose of this change (that room really did receive nothing). But run `pnpm send:channels` again
  for that room and the item **goes out again**. That is the intended behaviour, but it differs from
  the habit of assuming a rerun does nothing. All three docs are fixed. Action: before the first
  batch after the upgrade, look on the board for `예약 취소됨` rows and keep only the ones that genuinely
  need re-sending (narrowing the send with `--ids`/`--outlets` makes it certain).
- **`pnpm clean` now also deletes `*.lock` files under `output/` — but only the ones the lock module
  itself judges safe to reclaim.** A send-ledger write takes a `<file>.lock` so writes cannot
  overlap even across processes, and if the process dies partway through, that file is left behind.
  The threshold exists **to never touch a lock a live send is holding**, so it now asks **the same
  three-way question the lock-reclaim rule asks**: a path with no lock on it is judged by age alone,
  as it always was; a lock younger than the window belongs to a live holder and everything it guards
  is left alone; and an older lock is watched, and deleted only if its **mtime does not move** over
  the confirmation window — a lock older than 31 seconds (the 30-second threshold + 1 second of
  confirmation) whose mtime moves is a live process stamping its own proof of life, which holds true
  even when the clock is wrong. A temp file (`*.tmp-…`) is judged not by its own timestamp but by
  **the lock of the ledger it is about to become**: the two are a pair created by one write and only
  the lock is refreshed, so measuring them separately deletes the temp file of a slow but healthy
  write and breaks its `rename`. Even so, **do not run `pnpm clean --yes` while a
  send or `pnpm serve` is running** ([`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §5) — the
  threshold is a safety net, not a permission slip. (When a locked file really is present, `clean`
  waits up to 1 second.)

### Added

- **Outlet (발송처) — a third axis alongside `type` and `channel`.** "Where did this go" used to be
  distinguished by channel alone, but **맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both `telegram`**.
  Nine rooms are now defined as the `ALL_OUTLETS` constant in `src/domain/outlet/models.ts` — the X
  post and the X article, four Telegram rooms (커뮤니티, 데브방, KOL방, 블록체인 커뮤니티방), two
  KakaoTalk open chats, and PR mail. Each room carries whether it is automatic (`auto`, a bot/API
  posts it) or manual (`manual`, a human pastes it), which types it receives by default, and (for an
  auto Telegram room) which chat id env var it uses. `type` is **what kind of copy this is**,
  `channel` is **what format it takes**, `outlet` is **which room it goes to**. `pnpm send:channels`
  now sends once per room rather than once per channel, and `--outlets <room id[,room id]>` narrows
  it to specific rooms. (For the dashboard board UI, see the next two entries.) See
  `docs/superpowers/specs/2026-07-29-outlet-board-design.md`.
- **One room can carry copy the others don't — a per-room override that forks on edit
  (fork-on-edit).** A group's copy is shared by every room that receives it, but when a reviewer
  edits and saves **one room's row** rather than the card, that room gets an independent copy of its
  own (`output/formatted/overrides.json`), is marked `✎따로`, and **must be approved separately to
  send** — approving the group leaves this room out. A room that has just forked out from under an
  already-approved group **always starts unapproved (`rendered`)**, because the edited copy has not
  been reviewed in that form yet. Pressing `그룹 글로 되돌리기` deletes the override and the room
  follows the group's copy and the group's approval again — the only way back (even if the copy
  happens to become identical to the group's, the override is a separate row for as long as it is
  still there). One pure function, `textFor()`, owns this resolution: the override when there is one,
  the group rendering when there isn't.
- **A room's forked copy is recorded in the lineage (`pnpm lineage`) too — including the copy
  discarded by `그룹 글로 되돌리기`.** A forked copy exists only in
  `output/formatted/overrides.json` and **cannot be regenerated** (re-run `format` and what comes
  out is the group copy). Yet `그룹 글로 되돌리기` deletes that sole copy in a single click, with no
  confirmation dialog and no error. `SaveOutletOverride` now appends to the lineage exactly like the
  other save sites — **① when the copy is saved** (the normalized body), **② when it is approved or
  unapproved** (so the status transition is visible), and **③ when a revert discards it** (read
  *before* the delete, the discarded body verbatim). The new stage name is `forked`, and the
  discriminator (`variant`) is **`type/outletId`**, parallel to a group's `type/channel`. So opening
  `pnpm lineage <itemId>` shows which room forked when, into what, and what it discarded, right
  beside the group's copy. A revert entry **prints the whole body under `버린 내용:`** — the one
  entry that is a full text rather than a diff, because a discarded copy is usually not one
  character different from the entry before it, so as a diff it would render as a single
  `(내용 동일)` line, and after a few edits the discarded copy survives nowhere in full.
  **Restoring is not automatic** — the lineage is a record, not a rollback, so recovery is the
  judgment of a human who copies that body and pastes it back. **Saves and approvals are
  best-effort like every other lineage write** (the save itself still succeeds when the lineage
  write fails — the copy stays in the override, so all that is lost is the history)**, but the
  revert alone is different**: if the body about to be discarded cannot be written to the lineage,
  the revert **fails and the override is not deleted** (surfacing as a 400 on the board). Deleting
  after a failed record would leave that copy nowhere at all. See
  `docs/superpowers/specs/2026-07-29-fork-preservation-design.md`.
- **`pnpm state:push` / `pnpm state:pull [--yes]` — Drive backup for the operational files that
  cannot be rebuilt.** Most of what lives under `output/` can be rebuilt (items re-collect;
  translations, conversions and renderings regenerate), but **these cannot**: the per-room forks
  (`formatted/overrides.json`), the send ledger (`publish/deliveries.json`, plus the legacy-format
  `publish/channels.json` that is read when that one is absent — on installs predating the outlet
  axis (PR #80) **that file is the entire send history**), the X article ledger
  (`publish/x-article.json`), and the sync ledger (`publish/state.json`). `state:push` bundles them
  into a single timestamped snapshot (`operational-state-<stamp>.json`) and uploads it to the
  `operational-state` folder on Drive — snapshots accumulate rather than overwrite, so the history
  is itself the rollback. The folder is created automatically on the first run, under the same
  parent folder as `steering-config`, and its id is printed (`GDRIVE_STATE_FOLDER_ID`).
  **`state:pull` is deliberately more careful than `config:pull`.** The steering config is a
  **share** — the maintainer pushes, teammates pull — but this one is **a record of what this
  machine has already sent**: take someone else's snapshot and a room that has already gone out
  reads as unsent, and one confirmation dialog later a months-old post goes out to a live room. So
  (1) without `--yes` it **only previews** and writes nothing, and the preview shows not file names
  but **each file's current row count beside the snapshot's** (`현재 128행 → 스냅샷 3행`), (2) before
  writing it first backs the current tree up to `output/archive/state-<stamp>/`, and (3) if parsing
  the snapshot or the backup fails it aborts **without writing a single character**. A local file
  the snapshot does not have is **left alone, not deleted** (marked `유지`) — deleting a live send
  ledger to match something that isn't there is precisely the accident this feature exists to
  prevent. See `docs/superpowers/specs/2026-07-29-fork-preservation-design.md`.
- **2차 검수 is now a board (발송판) instead of a list.** In place of the old screen, which
  enumerated `(itemId, type, channel)` renderings, one card now holds a single `type · channel` copy
  (and its approval status), with **the rooms that receive that copy** attached below it, one row
  each. An auto room gets `발송` (the confirmation dialog shows the room name together with the copy
  that will go out; once pressed there is no undo); a manual room gets `복사` + `전달함` (a
  cancellable record a human leaves themselves). A room that spans several cards (데브방, for
  example, receives both 공지 and 해설) is marked `n/m`, and hovering a row lights up that same
  room's other rows with it. Per-destination emission (the actual bytes/characters that will go out)
  and the comparison against the conversion source moved inside the card, and the separate detail
  screen (`RenderingDetail.tsx`) is gone. **Only the text unit being edited (before save) locks, not
  the whole card.** While the group field is being edited, the group itself and the `발송` · `복사` ·
  `전달함` of every room that uses the group copy as-is (= has not forked) lock; while one room's
  `✎ 따로 쓰기` field is being edited, **only that room** locks — the neighbouring room's row stays
  pressable. This still prevents an old saved copy from going out by accident, while keeping a stray
  edit in one room from freezing unrelated rooms as well (the first implementation locked the whole
  card, but then an attempt to unlock a locked row had the side effect of silently forking that room
  out of the group, so it was narrowed to what it is now). `[변환 준비]` (writes out only the
  worksheet for the checked types, the equivalent of `convert:prepare` — this project has no Claude
  API, so the actual conversion is still the local agent + `convert:save`'s job) and a per-card
  **`[포맷 다시]`** (pure code that re-renders that card in place through `FormatVariants`, so it
  really does run) can be triggered from this screen too. `포맷 다시` **discards the currently saved
  copy and approval status** — the confirmation dialog spells out what will disappear first, there
  is no undo, and the copy of a room that has forked with `✎따로` is unaffected.
- **A delivery record for manual rooms (`전달함`).** Whether a room a bot cannot reach (the two
  KakaoTalk open chats, Telegram KOL방 and 블록체인 커뮤니티방, PR mail) was delivered to is now
  recorded in the ledger as well. `MarkDelivery` writes a `delivered` row for `(item, type, room)`,
  and a wrong tick can be undone — it is a record of a human **claiming** they sent it, so it is
  cancellable. A `sent` row, which a bot actually sent, by contrast cannot be undone (undo it and
  the next run sends the same copy to a live room again). Ticking `delivered` on an auto room is
  refused too — the bot would read that row, decide "already sent", and silently skip.
- **Two new conversion types — `explainer`(해설) and `casual`(소통).** Until now the only copy going
  out over Telegram was `announcement`(공지), so there was no way to pitch the same news differently
  to 데브방 and 커뮤니티방. `explainer` doesn't stop at what happened but spells out
  **why it matters and how it works** (pitched at 맨틀 한국 데브방); `casual` is **light news** the
  community has room to react to together — an anniversary, a winner announcement, an invitation
  (pitched at 맨틀 한국 커뮤니티). Both keep the 존댓말 (polite form) and 규제 표현 (regulated-claim)
  rules exactly as they are; the difference is not style but **register**. Each is steered by its own
  `conversion/explainer.md` / `conversion/casual.md` guide, and the default channel for both is
  `telegram`. Every place that uses `ConversionType` (labels, default channels, the few-shot store,
  the `doctor` steering check, CLI usage strings) derives from `ALL_TYPES`, so no separate wiring was
  needed — the existing invariant tests catch an omission. `conversion/{kol,pr}.md` were filled in
  this time too, from skeletons (7 lines each) into real guides.

- **`pnpm config:push` / `pnpm config:pull [--dry-run]` — steering config backup & share via
  Drive.** The git-ignored steering config (`translation/` + `conversion/`, 15 files,
  `*.example.*` skeletons excluded) is the single most valuable, evolving artifact in the
  project — the few-shot corpuses auto-grow on every `translate:save`/`convert:save --approve`
  and `translation/tm.json` grows on `tm:promote` — yet it lived only in one person's working
  tree, with no version control and no backup. `config:push` bundles the config into one JSON
  manifest and uploads it as a timestamped `steering-config-<stamp>.json` snapshot to a
  dedicated Drive folder (auto-provisioned on first run via `GoogleDriveProvisioner`, printing
  `GDRIVE_CONFIG_FOLDER_ID=<id>` to add to `.env`); snapshots accumulate, so any past state stays
  recoverable. `config:pull` finds the newest snapshot and restores it, backing up the current
  local config to `output/archive/steering-<stamp>/` **before** writing anything (a backup
  failure aborts the pull before any file is touched); `--dry-run` reports which files are new/
  modified without writing. Single-maintainer model — push is local→Drive, pull is Drive→local,
  last push wins, no multi-writer merge. Not storage-mode-gated: it only needs Google auth and
  the folder id, same as `google:auth`. See
  `docs/superpowers/specs/2026-07-28-config-sync-design.md`.
- **`pnpm lineage [itemId]` — always-on per-item lineage.** Every save through the four
  content-producing use-cases (`SaveTranslation`, `SaveConversion`, `SaveRendering`,
  `ApproveRendering`) now appends a stage snapshot — best-effort, never blocks the save — to
  `output/lineage/<id>.jsonl`, so a later overwrite (align, refine, approve) never loses the
  previous version. `pnpm lineage <itemId>` prints the item's journey with a per-revision diff
  against the previous entry of the same stage; `pnpm lineage` (no id) lists every item with
  lineage. Wired at every save site (`translate:save`, `convert:save`, `format:save`, and the
  `pnpm serve` dashboard). See `docs/superpowers/specs/2026-07-28-item-lineage-design.md`.
- **`pnpm translate:align [--ids …] [--since …] [--limit …]` — optional TM alignment pass.** A second,
  focused pass over already-drafted-but-unapproved translations (`status === "translated"`), sitting
  between `translate:save` and 1차 검수. For each draft it selects the top **K = 3** `translation/tm.json`
  precedent pairs by shared-anchor overlap with the draft's English `sourceText` (reusing the #52
  anchor engine; anchor-only, a lexical/text-similarity fallback for anchorless drafts is deferred) and
  writes a slim worksheet — 원문 / 현재 번역 / 선례, no glossary or style guide — to
  `output/translations/worksheets/align-<stamp>.md`. A draft with no shared-anchor precedent is skipped,
  not emitted. The local agent revises each draft's phrasing/terminology to match its precedents (a
  correction, not a re-translation) and writes it back with the **existing**
  `translate:save --id <id> --file <korean.txt>` (no `--approve`) — 1차 검수 remains the human gate; no
  new store, port, or `pending.json`. See
  `docs/superpowers/specs/2026-07-28-tm-alignment-pass-design.md`.
- **`pnpm send:channels [--target telegram|x|both] [--ids …]` — §8 channel delivery.** Sends each
  approved channel rendering to its real channel: **Telegram** via the Bot API (`sendMessage`, HTML,
  one message per segment, replies chained), **X** via **Typefully** (v2 draft published now, polled
  for the tweet url). Idempotent — a local ledger `output/publish/channels.json` (row per
  `(itemId, type, channel)`) means a succeeded send never repeats and a failed one retries. Works in
  any storage mode (the senders need only their own tokens); recording to the Sheet `history` tab is
  cloud-only and best-effort. X goes through Typefully only — no official X API, no twitterapi.io
  write (ban-risk on the official account). Config: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
  `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`. Kakao/mail senders and media are out of scope.
  See `docs/superpowers/specs/2026-07-27-channel-delivery-design.md`.
- **`pnpm metrics:record [--month YYYY-MM]` — monthly X performance into the team workbook.** Reads
  the human `KOL list` tab (X rows only, matched by header name), then for the KR official account
  (`REFERENCE_X_HANDLE`, default `0xMantleKR`) and each X KOL fetches follower count + that month's
  authored tweets and writes `followers / posts / views / engagement` to a machine-owned
  `x-performance` tab, upserting one row per `(account, month)`. Raw numbers only — Avg/rates/
  Cost-per-Impression stay as spreadsheet formulas; the human roster/contract/monthly tabs and cost
  columns are never written. Telegram KOLs are left for manual entry (twitterapi.io is X-only). Cloud
  mode + the OAuth `spreadsheets` scope + `GSHEET_ID` required; `skipIfLocal`-gated. Not yet
  live-verified. See `docs/superpowers/specs/2026-07-27-x-performance-tracker-design.md`.
- **Translation memory from @0xMantleKR.** The team's Korean X account publishes translations of
  Mantle_Official's English posts, so the two accounts form real approved EN→KO pairs.
  `pnpm collect:reference` collects @0xMantleKR into an isolated `output/x/reference/` store (never
  the translation queue); `pnpm tm:measure` reports the account's post count and estimated backfill
  cost before a full crawl; `pnpm tm:pair` proposes EN↔KO pairs by shared cashtag/hashtag/mention
  anchors within a temporal window and writes a review worksheet; `pnpm tm:promote` writes the pairs
  a human accepted into `translation/tm.json`. `translate:prepare` now inlines the curated few-shot
  (unchanged) **plus** the TM pairs most relevant to the batch (by same-language anchor overlap),
  replacing the old last-8-by-recency rule. The reference account handle is `REFERENCE_X_HANDLE`
  (default `0xMantleKR`). See `docs/superpowers/specs/2026-07-27-translation-memory-backfill-design.md`.
- **X Article bodies are collected.** `advanced_search` has always returned X Articles inside a
  normal `from:<user>` result, but their tweet `text` is a bare t.co link — a 12,000-character
  report entered the translation queue as one URL, silently. `SourceTweet` now carries an optional
  `article`, `CollectAuthoredContent` fetches each body via `GET /twitter/article?tweet_id=` (one
  call per article not already stored, after thread gap-filling — an article's body is never
  re-fetched once collected), and `XContentSource` renders the Draft.js content
  blocks to markdown. `ContentItem.kind` (`"post"` / `"article"`) is set by `XContentSource` and
  labels the item in the translation worksheet (`### <id> [article]`); `Translation`, what the
  dashboard reads after translation, carries no `kind`, so the post-translation review queue still
  cannot tell them apart. A `divider` block is deliberately **not** rendered as `---`, which `toCanonical` would read
  as a post boundary; `Italic` is flattened. Conversion (§5) and channel formatting (§6) are
  unchanged and still assume post-shaped input — see
  `docs/superpowers/specs/2026-07-23-x-article-support-design.md`.
- **`pnpm impressions:record` (§9b ③).** Reads the Sheet `history` tab, fetches each published X
  post's current view count via the existing `SourceGateway.fetchByIds`
  (`GET /twitter/tweets?tweet_ids=`), and writes it to the reserved `impressions` / `impressionsAt`
  columns (H/I) — the columns `RecordPublish` deliberately leaves empty. `--since <YYYY-MM-DD>`
  narrows to rows published on or after a cutoff; deleted or metric-less tweets are skipped per row.
  X only for v1; not yet live-verified (needs the `spreadsheets` scope, like §9a).
- **`pnpm collect` `--since`/`--limit` flags + coverage ledger.** `--since <3d|12h|1w|ISO>` sets a
  time floor (relative or absolute), overriding the stored watermark; `--limit <n>` caps how many
  threads (by latest tweet) are kept. Either flag makes the run ad-hoc: the watermark
  (`output/x/state.json`) is left untouched, so only flag-less runs advance it. Every run appends a
  coverage record to `output/x/runs.json` — requested/covered range, thread/tweet counts, and a
  `truncated`/`gap` marker when `--limit` or the `MAX_PAGES` (50) pagination cap stops the run short
  of the requested floor. Recommended automation: an hourly `pnpm collect <target> --since 2h` — the
  2h window overlapping the 1h cadence keeps coverage continuous, and upsert dedupes the overlap.
- **Canonical rendering text.** `output/formatted/renderings.json` now stores destination-independent
  canonical text instead of pre-spelled output: bold is `**text**`, links are `[text](url)`, one
  blank line is a paragraph break, and two blank lines — or a lone `---` line, which `toCanonical`
  now also absorbs because the pipeline has always used it as `XContentSource`'s
  `THREAD_TWEET_SEPARATOR` — mark a post boundary (x-channel only; every other destination flattens
  it to a paragraph break). Destination spellings are derived at read time by
  `src/domain/formatting/emitters/`, not stored.
- **Six destinations, one approval per channel.** A channel (`x`/`telegram`/`kakao`/`pr_mail`) is
  still approved once, exactly as before. `x` now reaches two destinations (`x_paste`,
  `x_typefully`), `telegram` reaches two (`telegram_paste`, `telegram_bot`), and `kakao`/`pr_mail`
  reach one each (`kakao_paste`, `pr_mail`) — six in total, never separately approved.
  `GET /api/renderings/:itemId/:type/:channel/emissions` computes only the destinations that
  rendering's channel can reach, on demand.
- **Dashboard: per-destination output with copy buttons.** The 2차 검수 view fetches `emissions` for
  the selected rendering, lets you switch between its destinations, and copies one segment or every
  segment at once — no more assembling the paste-ready text by hand.
- **`--refine` worksheet gained channel constraints, a filtered glossary and a length report.** The
  constraints block is generated from the emitters' own constants (`X_MAX_WEIGHTED`, `TELEGRAM_MAX`,
  `KAKAO_FOLD`) so it cannot drift from the code; the glossary section lists only terms actually
  present in the batch's drafts; and each draft is preceded by a per-segment `length/limit` report
  computed against its channel's primary destination.

### Removed

- **Legacy `TELEGRAM_CHAT_ID` is gone for good.** It was the single variable from the days when
  there was only one room, and after the split into per-room variables it survived only as the
  fallback for an empty `TELEGRAM_CHAT_ID_COMMUNITY`. The code no longer reads it at all — leaving
  it in `.env` changes nothing. **The problem was that the fallback pointed at exactly one room
  (community):** a half-migrated `.env` could quietly send copy meant for 맨틀 한국 데브방 out to
  맨틀 한국 커뮤니티, and a send cannot be undone. For the same reason `TelegramConfig.chatId` and
  `TelegramBotSender`'s default chat id constructor argument are gone too — a room is a property of
  the send, not of the sender, and with a default in place a request that forgot to name a room goes
  out to whatever room that default points at. `loadTelegramConfig()` now returns the token only,
  and a room with no chat id simply stays unset and is reported by name. The Telegram block in
  `.env.example` was rewritten to match the file's conventions (English, `[REQUIRED for …]` tags).

### Changed

- **Sending now checks the source translation's approval too — un-approving at 1차 reaches the stages
  below it.** Until now `승인 취소` reverted the translation's status and nothing else. The conversions,
  renderings, and per-room forks derived from that translation stayed exactly as they were, and
  neither `SendChannels` nor `buildBoard` ever looked at the translation — so **copy you had decided
  not to publish still appeared on the board and went out with one button press.** Now three things
  must all hold before a single room can go out — the source is in the approved state, this room's
  copy is approved, and **that approval is later than the source's last approval**. The third
  condition is what catches the `승인 취소 → 원문 수정 → 재승인` flow: re-approving means *the Korean is
  right*, not *the copy derived from that Korean is right*, so the room stays locked until a human
  looks at it again. **Nothing is deleted** — refined copy, `✎따로` forks, and the approval record all
  stay exactly as they are and are only locked. The verdict is never stored: `sendBlock`
  (`src/domain/send/sendBlock.ts`) computes it every time by comparing the two approval timestamps,
  so there is no invalidation pass and no recovery path, and the lock lifts by itself the moment you
  approve again. **The screen and the CLI use the same predicate** — for the same reason `isStale`
  backs both `drive:publish` and `pnpm status`, there is no state where the board paints `발송` while
  the CLI refuses. A fork is designed to survive `[포맷 다시]`, so re-converting after a source edit
  leaves **the group on the new copy and the fork on the old one**, both showing as `승인` — `textFor`
  now returns the fork's **own** approval timestamp along with it, so only that room locks.
  `SendChannels` takes `TranslationStore` as a **required** argument (it cannot be optional: leave
  it out and the copy goes out unchecked).
- **The conversion approval step is gone — there is one human review gate, 2차.** `format` used to
  pick up only conversions with `status === "approved"`, which made three review gates (1차
  translation → conversion approval → 2차 channel). But the middle gate **had no screen** — the only
  way through it was `pnpm convert:save --approve`, so the operator who pressed `[변환 준비]` →
  `[포맷 다시]` on the dashboard had no way to find out why nothing had happened. `format` and
  `format --refine` no longer look at a conversion's status. Formatting is a mechanical transform
  and nothing leaves the machine, so the gate bought nothing beyond making someone read the same
  copy again at 2차. **The real send lock is unchanged** — `send:channels` still emits approved
  *renderings* only. `convert:save`'s `--approve` flag is removed, and a conversion is always saved
  as `converted`.
- **Conversion few-shot promotion moved to the 2차 approval.** `convert:save --approve` used to
  double as the promotion, but the copy at that moment is **something the agent has just written and
  nobody has read**. With `--approve` gone under the change above, the promotion path would have
  gone with it, so `ApproveRendering` (the 2차 approval) now promotes the conversion behind the
  rendering into `conversion/few-shot.<type>.json` and marks the conversion `approved` as well — it
  is the one point in the pipeline where a human actually reads the converted copy. Approving
  several channels of the same type still leaves a single example, because the upsert is keyed on
  `itemId`. The target text of the promoted example is the **conversion**, so the per-channel edits
  made at 2차 do not reach the corpus (the same as when the promotion lived in `convert:save`).
- **The send ledger is re-keyed by room rather than by channel — `output/publish/deliveries.json`.**
  The old ledger `output/publish/channels.json` had one row per `(itemId, type, channel)`, but
  맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are **both `telegram`**. So one send to the community room overwrote that
  row as "sent" for the entire channel, and **맨틀 한국 데브방 received nothing and was then silently
  skipped on the next run** — this re-keying exists because of that bug. The new ledger leaves one
  row per room, keyed `(itemId, type, outletId)`. An existing `channels.json` is **migrated
  read-only** and read from, attributing each old row to that channel's primary room
  (`PRIMARY_OUTLET_BY_CHANNEL`: `telegram` → `tg-community`, `x` → `x-post`, `kakao` →
  `kakao-blockchain`, `pr_mail` → `pr-mail`). The original file is neither edited nor deleted, so a
  rollback loses nothing.
- **The Sheet `history` tab became per-room for the same reason — an existing sheet needs one manual
  step.** A `history` row's identity changed from `(itemId, type, channel)` to
  `(itemId, type, outletId)`. Before, sends to two rooms **shared one row, so whichever went out
  later — 맨틀 한국 데브방 — overwrote 맨틀 한국 커뮤니티's `postId` and `t.me` link** — every Telegram send lost
  one room's record. The room id goes in a **new column J (`outletId`)**.
  - **What you have to do on an existing sheet:** type `outletId` into **cell J1** of the `history`
    tab yourself. The header is written automatically only while the tab is empty
    (`ensureHistoryTab`), so a sheet already in use never gets the label. The values themselves
    accumulate in column J perfectly well without it — the label is there for a human to read.
  - **Impression columns H and I were left untouched.** That is exactly why `outletId` sits at the
    end (J) rather than next to `channel` — inserting a column in the middle would shift the
    existing rows' impression values over by one cell on a sheet nobody has touched yet, mixing them
    into the send values. `impressions:record` still writes H and I only.
  - **Old rows with an empty room cell stay as they are.** Send the same item again after the
    upgrade and a new per-room row is appended instead of the old row being edited.
- **`TELEGRAM_CHAT_ID` is superseded by the per-room
  `TELEGRAM_CHAT_ID_COMMUNITY`/`TELEGRAM_CHAT_ID_DEV` (deprecated).** Now that sending is per room,
  every room needs its own chat id. A fallback is kept so that sending does not stop the moment you
  `git pull` — when `TELEGRAM_CHAT_ID_COMMUNITY` is empty the legacy `TELEGRAM_CHAT_ID` is used
  **for the one room 맨틀 한국 커뮤니티** and a warning is printed (맨틀 한국 데브방 is not covered by the
  fallback). A room whose value is empty is not sent to, and it is reported not as `failed` but
  separately, as `· 미설정 N (TELEGRAM_CHAT_ID_DEV)` on the summary line — an install still running the
  legacy setup is not broken. How to configure it:
  [`docs/ko/setup/channels.md`](docs/ko/setup/channels.md) T-3.
- **A room that has never been delivered to does not get the backlog pushed out to it
  automatically.** `renderings.json` is never cleared and approval states stay put, so configuring a
  new room leaves **every rendering approved up to that point** undelivered for it. Left alone, the
  next single `pnpm send:channels` dumps the whole backlog into a live room. Now, when a room with
  an empty ledger has 2 or more items waiting, the run logs a warning with the room's name and the
  count and **withholds** them; they go out only once you name that room explicitly with
  `--outlets <room id>`.
- **`pr-mail` became a manual (`manual`) room.** With no mail sender yet `send:channels` cannot
  reach it, and because it was `auto` it was refused even the `전달함` tick — **a room you could
  neither send to nor record as sent**. It goes back to `auto` the day a mail sender exists.
- **`history` auto-creates its tab, so one workbook can hold every machine tab.** `RecordPublish`
  (behind `history:record` and `send:channels`) now ensures the `history` tab + header before
  writing, mirroring how `metrics:record` handles `x-performance`. You can point `GSHEET_ID` at your
  existing team workbook and skip `sheet:init` — a `send:channels` run in cloud mode no longer logs
  `history record failed: HTTP 400` just because the sheet was created by hand or by `metrics:record`
  rather than by `sheet:init`. (`targets` for `targets:list` is still the one tab you fill by hand.)
- **`--x-bold` removed.** Unicode "bold" characters are skipped entirely by screen readers, are not
  matched by X search, and cost double the weighted length of a plain character. `pnpm format
  --x-bold unicode` and `--x-bold=unicode` now fail immediately, naming the reason. Write
  `**bold**` in canonical text instead — each destination decides how to spell it.

### Fixed

- **Closed the last route by which a month-end quota reset defeated the resend guard outright — it
  was open once a month, in a window a few seconds wide.** The resend guard tells "the schedule was
  cancelled" apart from "the record of a post that had already gone live was deleted" by **comparing
  the monthly publishing quota before and after** (because Typefully answers `204` to both — see the
  `재발송` cancel entry in this same section). That comparison was one line, `did used go up`, and
  **`used` is not monotonic**: when the quota resets on the 1st of the month (KST) it **goes down**.
  So when the month rolled over inside the guard's check window, `14 → 1` read as "nothing
  published", and the resend went out even when that `1` was our own draft having just published.
  Now **both** `used` and `remaining` are read, and if the numbers went backwards the guard
  **refuses** — because it cannot be reconciled: `used + remaining` is the plan's ceiling and is
  preserved across a reset as well as across a publish, so no arithmetic separates "only a reset
  happened" from "a reset happened and our post published straight after" (`used 0` is no alibi
  either — a publish charged in the old month is wiped by the reset, so a live post can sit behind a
  zero). Not deciding from `resetsAt` is a deliberate choice too: this machine's clock is measurably
  wrong (see the entry below), and working out whether the month rolled over from a local comparison
  would either refuse all month or never refuse once. **That the numbers go backwards is itself the
  account's evidence that it reset, and that needs no clock.** A response whose two numbers do not
  move in opposite directions by the same amount is now refused as well — another case the old
  one-line comparison sent straight through. The refusal names which of the three it was (read
  failure · month reset · numbers that do not square). A momentary error is worth clicking again, a
  month rollover will not happen again this minute, and numbers that do not square are worth
  reporting — because the operator can make a different call on that difference. All three drop the
  draft id from the row (leave it there and the next reconcile pass retires that row to `예약 취소됨`,
  which reopens the room, and the duplicate just prevented goes out with the next batch).
- **The resend refusal that flatly asserted "이 글뿐이었습니다" — this was the only post pending — now
  writes the limit of that judgement and the way out alongside it.** The count of pending scheduled
  drafts is **counted from our own ledger**, so a draft held by hand in Typefully's own UI is not in
  it — meaning the slot that was spent could have been that one, and that sentence now sits in the
  same breath as the claim. More importantly, that branch **was leaving out
  "실제로 안 올라갔으면 재발송을 한 번 더 누르세요"** (if it really did not go up, press 재발송 once more). It did so
  because it took the case to be certain, and the pending count does not guarantee that much. An
  operator whose post did not in fact go up was left with a closed room and no guidance at all.
- **`게시 확인` reported the room next door's outcome as this room's.** The reconcile pass sweeps
  **every** pending row in both ledgers and answers with totals only (`reconciled n · retired n`).
  The button picked this row's message from those totals, so in the common case where one batch has
  left more than one room queued at Typefully it was wrong in both directions — when **another
  room's** draft was deleted, this room was told "예약된 게시물이 게시되기 전에 취소되었습니다" (the
  scheduled post was cancelled before it published),
  right under a badge the same click had just painted `예약됨`; and when **another room** published,
  "아직 게시되지 않았습니다" (not published yet) was left out so the click said nothing at all — which, on a
  board that redraws itself, reads as success. The message now comes from **that row's own status**,
  which arrives with the response. The quota re-read stays ledger-wide — the quota is per account,
  so it moves whichever row published.
- **A ledger lock now decides by proof that its holder is alive instead of guessing that it "looks
  old" — because this machine's clock really is wrong.** A write to the send ledger takes a
  `<file>.lock` so writes cannot overlap even across processes, and if that file's mtime is older
  than 30s it is presumed left behind by a dead process and reclaimed. Two things were wrong. (1) It
  could steal the lock of a **legitimate** job that took longer than 30s, and (2) this development
  machine's (WSL2) system clock swings ±22.7s because `systemd-timesyncd` and Hyper-V host clock
  sync are **both** stepping it (a ~5s period, two independent measurements, 0ms on the monotonic
  clock). Which means a lock taken a moment ago can read as 22s old. Now the side holding the lock
  re-stamps its own lock file's time every 5s while it works (a heartbeat), and a reclaim happens
  **only after confirming that the stamping has stopped for a continuous 1s** — that 1s is measured
  on the monotonic clock, which a clock jump cannot shake. And the confirmation window is **bound to
  the very mtime it was watching**: if the time moves (= the other side is alive and stamped it),
  the window is counted again from the start. Because even if a wrong clock keeps making the lock
  look old, the fact that the file moved is true without a clock. Without this, the 1s accumulated
  while watching a dead lock could be spent **deleting a live lock that arrived in the meantime**
  (reproduced: a follow-up lock that looked stale by only 64ms was deleted by a confirmation window
  that advertises 1s). A short CLI is never kept from exiting by the heartbeat timer (`unref`).
  Alongside: **if releasing the lock fails after the job finished, it now only warns and the job
  keeps its success**. A send that fully went out but is reported as a failure because lock cleanup
  failed makes the next run post the same copy into a live room a second time. **One hazard this
  does not close remains**: if the process holding the lock stops for more than 30s through a
  suspend or a freeze, the heartbeat stops with it, so that lock can still be reclaimed. Do not put
  the machine to sleep mid-send.
- **Closed a route by which the whole approved backlog went out to a room that had never received
  anything.** For a newly configured room, every approval in `renderings.json` sits there as "not
  sent", so `send:channels` **withholds all of them when a room receiving for the first time has two
  or more pending** and requires the room to be named with `--outlets <room id>` (the first-delivery
  guard). But when this guard judged "has this room ever received anything", it **was counting
  `예약 취소됨` (`dropped`) rows as delivery history too.** And that is so even though `dropped` means
  the scheduled draft was deleted before it published — that is, that the room received **nothing**.
  So a single cancelled schedule lifted the guard, and the entire approved backlog went into a live
  room at once (verified: with an empty ledger, `보류 3건` (3 withheld); with one `dropped` row,
  `발송 3건` (3 sent)). The guard now uses the same rule as every other such judgement
  (`deliveredToRoom`).
- **`pnpm clean --yes` could break a ledger write mid-send.** An atomic write writes a temp file and
  then renames it, and if `clean` deletes the temp file in between, the rename fails and you get
  **the send went out but the ledger has no record of it**
  (`⚠ … was SENT but could NOT be recorded in the ledger — a rerun will re-send it`). The next run
  posts the same copy into a live room a second time. The 30s threshold that applied only to lock
  files was extended to temp files in exactly the same way — and later in this same release the rule
  became sharper still: a temp file is judged by the lock on the ledger it is about to become, not by
  its own age (see the ledger-lock entry above, and `Upgrading`). Even so, **do not run `clean --yes`
  mid-send** — the threshold is a safety net, not a permission.
- **When a resend fails after cancelling the schedule, that row is now restored as `예약 취소됨` rather
  than `발송됨`.** Pressing `재발송` on an X post that has not published yet cancels the scheduled
  original first, and if the send after it then failed — quota exhausted, a send error — the
  original row was being restored **as it was**: a `발송됨` row pointing at a draft that has already
  been deleted. The board then draws a schedule that does not exist as `예약됨`, one of the month's 15
  slots stays held, and that room is treated as already delivered and skipped until a reconcile pass
  runs once (2 minutes on the dashboard, **never** on a CLI-only install). It now restores the row
  as `예약 취소됨`, exactly what actually happened, so the room and the one quota slot are freed
  immediately.
- **Closed the hole where `재발송`'s cancel may not have been a "cancel" but a "deletion of the record
  of a post already live" — the last route to a duplicate X post.** Measured live 2026-07-30:
  Typefully gives **the same `204` when it cancelled a schedule and when it deleted a draft that had
  already published**, and a follow-up read is `404` either way. Which means the response alone
  cannot tell them apart, and if the original published between the check and the cancel (both are
  real network requests, a few seconds once retries are counted), the code up to then believed the
  cancel had taken and sent the new post — the same post twice on a brand account, irreversibly. The
  same measurement also confirmed that **the publishing quota is charged at the moment of
  publication, not when the draft is scheduled**, so the guard now **compares the monthly quota from
  before the check begins with the one from right after the cancel** to judge whether anything
  published in between (the quota can be slow to reflect it, so the second read waits 1.5s — the
  resend's response is that much slower). If the quota fell in between it **refuses**, and if the
  quota could not be read so the judgement is impossible at all it **refuses as well** (what is
  unknown goes the safe way). A refused row is left as `발송됨` with no link and `게시 확인` no longer
  touches it — leaving the draft id on it would make the next reconcile pass retire it to `예약 취소됨`,
  and then that room reopens and **the next batch posts the very duplicate just prevented.** Instead
  the deleted draft id is **named in the refusal**, leaving a handle to match against the account
  and Typefully's own record. If it truly did not go up, pressing `재발송` once more sends it — and the
  confirmation dialog that comes up then asks in terms that fit this state:
  "첫 글일 수도, 두 번째 글일 수도 있습니다" (this may be the first post, or it may be the second) (it used to ask
  about this row too as "이미 나간 글이 있고 하나 더 올라갑니다" — a post has already gone out and one more will go
  up — without one true sentence in it). Detailed remediation in
  [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §2 step 11. The quota being per account, when
  there is a **possibility that another schedule from the same batch published and spent it**, the
  message says so; and conversely the judgement that "이 글뿐이었다" (this was the only one) carries the
  caveat that it is **counted from our own ledger** — written as certain only when it is certain. In
  addition, a response with no `publishing_quota.used` is no longer quietly read as `0` but raised
  as an error: with `0` on both sides the comparison always comes out "unchanged", so the guard
  would send a duplicate while believing it had checked for itself.
- **The `재발송` confirmation dialog said the opposite of the facts for a row that had not published
  yet.** That row's badge says `예약됨` two lines above, while the dialog said "이 방에는 …에 나간 글이 있습니다.
  그 글은 지워지지 않고, 이 방에 글이 하나 더 올라갑니다" (this room has a post that went out at …; that post will not be
  deleted, and one more post will go up in this room). All three were wrong — that time is when it
  was **scheduled**, the scheduled original is cancelled so **only one** post goes up, and there is
  no earlier-sent link either. A row in the scheduled state now states what will actually happen
  (cancel the original schedule and post only one; stop the send if the original has already
  published or the cancel fails). The explanation that appears on hover was fixed along with it.
- **Collection now expands `t.co` shortlinks instead of storing the redirect.** `normalizeTweet`
  replaces each `t.co` link in a tweet's `text` with its real `expanded_url` (from `entities.urls`)
  and removes a tweet's own photo/video `t.co` self-links — that media stays on
  `SourceTweet.media`, it was never a link. Translations and Telegram/X delivery now carry the real
  URL instead of `t.co`. See `docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md`.
- **Outbound `fetch` survives a broken IPv6 route (common on WSL2/Docker).** Node's default
  Happy-Eyeballs family autoselection raced a resolvable-but-unroutable IPv6 address against IPv4 and
  returned `ETIMEDOUT`, so a command could die with a bare `fetch failed` even though `curl` reached
  the same host — hit while live-verifying `send:channels` against api.telegram.org. Every CLI now
  disables family autoselection at startup (`src/cli/preferIpv4.ts`, equivalent to
  `--no-network-family-autoselection`).
- **A re-collect no longer reverts a stored X Article body to a bare link.** Neither
  `GET /twitter/tweet/thread_context` (gap-filling a missing thread root) nor a routine
  `advanced_search` re-normalize ever carries `article.blocks` — only `GET /twitter/article`, via
  `fillArticleBodies`, does. Before this fix, `LocalJsonStore.upsert` let the incoming
  (blockless-or-article-less) tweet win outright, so any collect run after the day an article was
  first fetched silently dropped its stored body back to a link. `LocalJsonStore.mergeTweet` now
  carries a stored article forward whenever the incoming tweet's own article is missing or has no
  blocks.
- **X length is now counted by weight, matching X's real limit — a bug fix, not a feature.**
  `weightedLength()` replaces a code-point count that compared `[...text].length` against 280. X
  actually counts by weight (`twitter-text` v3 config): a Hangul syllable costs 2, so a pure-Korean
  post maxes out at **140 characters**, and any URL counts as exactly 23 regardless of its real
  length. The old check silently passed over-limit Korean posts between 141 and 280 characters with
  no warning at all.

## [0.2.0] - 2026-07-21

### Upgrading — action required for existing installs

#### `git pull` deletes your steering config — restore it before running anything

Untracking `translation/` and `conversion/` means the merge commit **deletes those ten files from
the index**. They were tracked before, so `git pull` removes them from your working tree too. Your
real glossary, style guide, locale and few-shot corpora disappear. This bites once, on the pull that
brings this release in.

**Do not run `pnpm config:init` to recover** — that writes generic skeletons from `*.example.*` and
would leave you with an empty glossary and no few-shot examples. Restore the real content from the
commit before this release instead:

```bash
# <pre-release> = the last commit before this release landed on main
for f in $(git ls-tree -r --name-only <pre-release> translation conversion | grep -v '\.example\.'); do
  git show "<pre-release>:$f" > "$f"
done
pnpm doctor   # "Steering config … ok" once they are back
```

Verify before continuing: `translation/glossary.json` should hold your real terms, and
`translation/few-shot.json` / `conversion/few-shot.x.json` your approved examples — not `[]`.

From then on these files are yours alone and git will not touch them again. Back them up somewhere
outside the repo; nothing in this project protects them any more, by design.

#### Set the storage mode

`HERALD_STORAGE_MODE` is now **required** and is never inferred. A fresh clone gets it from
`.env.example`, but an existing `.env` predates it, so the cloud commands (`drive:publish`,
`drive:init`, `sheet:init`, `targets:list`, `history:record`) will fail until you add one line:

```bash
# append to your existing .env — "cloud" if Google/Lark Drive is your record of truth
HERALD_STORAGE_MODE=cloud
```

Defaulting it was considered and rejected. Defaulting to `local` would silently misroute a cloud
operator's work: `drive:publish` still runs and still reports success, but the documents land in
`output/publish/local/` instead of Drive — guessing wrong sends published work to the wrong place
either way, which is worse than failing loudly once.

### Added

- **`.env.example` reorganised, and every variable tagged.** It is now ordered by when you
  actually need a value — always required, then per collection source, then cloud-mode only, then
  local tools — and each entry is marked `[REQUIRED]` (with the command that needs it),
  `[OPTIONAL]` (with its default) or `[PICK ONE]`. `HERALD_STORAGE_MODE` documents the intended
  path explicitly: **start on `local`, promote to `cloud` when setup is finished** — local mode is
  not a fallback, it runs the whole pipeline, and it makes you the owner of the git-ignored
  `output/` tree. Two variables the code reads were missing entirely: `GOOGLE_OAUTH_SCOPE`
  (`google:auth` reads it; it appeared only inside a comment, so copying the file gave you no slot
  for it) and `PORT` (`serve`). A stale `docs/guides/…` path was corrected — that sweep had covered
  `*.md` and `*.ts` but not `.env.example`.
  `tests/config/envExample.test.ts` now keeps this from drifting again: it fails when `src/` reads
  an undocumented variable, when the file lists one nothing reads, or when a variable is untagged.

- **`docs/ko/setup/steering.md`** — how to actually obtain the real `translation/`+`conversion/`
  config. It is not in git, and a new team member had no documented way to get it: `team-runbook.md`
  claimed these files were "what `pnpm config:init` creates", which is false — `config:init` writes
  empty skeletons. Following that sentence produced translations with none of the team's
  terminology, and `pnpm doctor` reported the setup as fine. Corrected, with a verification step
  (`pnpm glossary` must not print `0 entries`) and the recovery procedure for losing them.

- **`docs/ko/review.md`** — a guide for the people who read, edit and approve the Korean copy but
  never open a terminal. Every existing Korean document assumed a shell in its opening paragraph,
  yet second-round review (§7) is dashboard-only, so that reader had no page at all. It covers the
  two review modes, the fact that `승인 ✓` stays disabled until you press `저장`, and where the
  per-channel review checklists live — `conversion/checklist.*.md`, which sit in the gitignored
  steering folder and were effectively undiscoverable.
- **`docs/ko/README.md`** — a role-based entry point ("what should I read?") for the Korean docs.

- **`announcement` conversion type** — community announcements (Telegram 공지방 + KakaoTalk) are now
  their own conversion type, steered by `conversion/announcement.md`. They were previously produced
  by the `kol` type, which is a different kind of writing: an announcement and a request sent to a
  KOL room travel over the same Telegram transport but follow opposite CTA rules (X and KOL copy
  avoid `~하세요` imperatives for regulatory reasons; an announcement uses them). Conversion type
  answers *what is written*, `Channel` answers *where it goes* — the two axes are deliberately not
  1:1, and `DEFAULT_CHANNELS_BY_TYPE` now reflects that: `announcement` fans out to
  `telegram`+`kakao`, and `kakao` moved off `x` (a KakaoTalk post reads like an announcement, not
  like a tweet). Existing `x` variants are unaffected; no stored data needed migrating.

- **`pnpm status`** — a pipeline-visibility command: reads the local `output/` stores and prints a
  per-stage funnel (collected → translated → converted → rendered → published, with approved
  sub-counts) so you can see how far data has flowed. Offline.
- **`pnpm doctor`** — a setup-diagnosis command: offline config checks per integration
  (twitterapi / Lark / Google Drive+Sheets), plus `--live` to mint tokens read-only and report the
  granted OAuth scopes (catches e.g. a Google token missing the `spreadsheets` scope, or Lark auth).
  Exits non-zero if any check fails.
- **Content shaping (F)** — §5 item conversion (`convert:prepare` / `convert:save`) rewrites an
  approved translation into X / KOL / PR variants with per-type steering config in `conversion/`
  and a per-type few-shot flywheel; §6 channel formatting (`format` / `format:save`) renders a
  variant for X / Telegram / KakaoTalk / PR-mail with deterministic formatters and an optional
  agent refinement pass.
- **Second review (§7)** — the local dashboard gains a **2차 검수** mode to list/filter, edit, and
  approve Module F channel renderings before posting. `ChannelRendering` gains a `rendered`/`approved`
  status; new `ApproveRendering` use-case and `/api/renderings` routes; approved text is copy-ready.
- **Google Sheet data hub (§9a)** — a team-editable Sheet as the automation's data hub via the direct
  Sheets v4 REST API (reusing the Google `TokenSource`): `sheet:init` provisions the `targets`/`history`
  tabs, `targets:list` reads the distribution targets (①), and `history:record` upserts publish rows (②).
  ③ impressions and §8 wiring are follow-ups.
- **`pnpm lark:chats`** — lists the chats the Lark bot is a member of (id + name), so you can find a
  chat id for `LARK_CHAT_IDS` without a raw API call.
- **`pnpm lark:send --chat <id> --text <…>`** — sends a text message to a Lark chat (defaults the
  chat to the first `LARK_CHAT_IDS` entry). The foundation for §10 (Lark bot); pipeline-content
  wiring is a follow-up.
- **Explicit storage mode** — `HERALD_STORAGE_MODE=local|cloud` decides whether Drive is the record
  of truth or everything stays local. `local` needs no cloud credentials — the post-collection
  stages (translate / convert / format) never call an external API either way, and `local` also
  skips `drive:init`, `sheet:init`, `targets:list` and `history:record` with a clear message
  (`drive:publish` is not one of them — in `local` mode it targets the filesystem instead of
  skipping); collection still needs a key for whichever source you use (`TWITTERAPI_IO_KEY` for X,
  the Lark app credentials for Lark), independent of storage mode. `cloud` behaves as before.
  Storage mode is never inferred.
- **Sync ledger** — `output/publish/state.json` now records which drive, remote id, URL, filename,
  content hash and timestamp for every upload (legacy key sets migrate on read). `pnpm status`
  reports published / unsynced / stale counts, so an item edited after publishing is visible.
- **`pnpm archive` / `pnpm clean`** — retention for worksheets and superseded batches under
  `output/archive/<date>/`; `clean` removes archives older than 30 days (`--older-than`) and temp
  files stranded by interrupted writes, listing them unless `--yes` is passed.
- **`pnpm config:init`** — creates the steering config from the tracked `*.example.*` skeletons.
- **Documentation set** — `docs/ko/{capabilities,quickstart,team-runbook,artifacts}.md` covering what
  the project does, how external and internal users run it, and where every artifact is stored;
  `docs/README.md` records the documentation rules.
- **`local` publish target** — `pnpm drive:publish` now writes the review/approved markdown documents to
  `output/publish/local/{review,approved}/` instead of skipping publication in
  `HERALD_STORAGE_MODE=local`. `--target` accepts a comma-separated list (`google,local`); `both`
  remains an alias for `google,lark`. The dashboard publishes in local mode too, and picks its
  target options from the new `GET /api/config`.
- **`LocalFileUploader.update`** — when a re-approval changes `publishFileName` (it embeds
  `approvedAt`'s date), the local uploader writes the new file and then deletes the old one, so a
  re-approved item ends up as exactly one document on disk — mirroring the Drive PATCH that
  updates content in place while preserving a file id.

### Changed

- **`pnpm doctor` no longer hard-fails in cloud mode over optional credentials.** Only the core
  cloud publish path — Google auth + Google Drive — is required in cloud mode (plus the storage mode
  and steering config, required in every mode). twitterapi.io and the Lark app are source
  credentials (needed only if you collect from that source), Lark Drive is an opt-in publish target,
  and the Google Sheet (§9a) is an optional data hub, so their absence is now a `warn` in both modes,
  never a `fail`. Previously a valid Google-Drive-plus-X setup exited 1 in cloud mode over the Lark
  and Sheet credentials it does not use. New `optionalCheck` helper in `src/doctor/checks.ts`.

- **`docs/guides/` moved to `docs/ko/setup/`.** `docs/` was splitting by two axes at the same
  level — language (`en/`, `ko/`) beside audience (`architecture/`, `guides/`, `superpowers/`) —
  so Korean setup procedures sat outside `ko/` and English design docs sat outside `en/`. The rule
  is now: only user-facing docs carry a language, so only they nest under a language folder;
  `architecture/` (English by rule) and `superpowers/` (an archive) stay at the top level. Files
  were renamed to drop the redundant suffix (`google-drive-setup-guide.md` → `setup/google-drive.md`).

- **The steering config now carries the KR team's real guidelines.** `translation/style-guide.md`
  (46 → 200 lines), `glossary.json` (36 → 78 terms), `locale.json`, `few-shot.json` and
  `conversion/x.md` (8 → 156 lines) were migrated from the team's Lark documents, which stay the
  canonical source — each file's `> 출처:` line links back to it. Review checklists live beside
  them as `conversion/checklist.<type>.md` and are deliberately **not** loaded into any prompt.
  Note `promptAssembler.renderLocale()` renders only the five fixed `Locale` fields; extra keys in
  `locale.json` load but never reach the prompt.

- **`pnpm doctor` checks a guide for every conversion type**, not just `conversion/x.md`.
  `loadTypeGuide()` falls back to an empty string when the file is missing, so a type without its
  `.md` used to convert with no steering at all and no warning.

- **`pnpm doctor` now looks at steering *content*, not just presence.** A `pnpm config:init` tree
  passed the check while steering nothing — an empty glossary and guides identical to their
  `*.example.*` skeletons still counted as ✓. It now reports `⚠ present but empty` and names the
  files. The missing-file hint also stopped pointing everyone at `config:init`, which is the wrong
  recovery for someone whose real files disappeared; it now distinguishes a fresh install from a
  loss and links `docs/ko/setup/steering.md`.

- **The real steering config left git.** `translation/` and `conversion/` now track only
  `*.example.*` skeletons; the actual glossary, style guide and few-shot corpus are local. Routine
  approvals no longer dirty the working tree.
- **`pnpm status` warns about unsynced/stale work in `local` mode exactly as in `cloud` mode.** The
  previous `(local mode — publishing disabled)` line hid a real backlog now that local publishing
  exists.
- **`skipIfLocal()` now gates four commands, not five.** `drive:publish` left the list — in local
  mode it targets the filesystem instead of skipping.
- **Requesting a cloud target in `local` mode now fails instead of skipping.**
  `pnpm drive:publish --target google` (or `lark`, or `both`) under `HERALD_STORAGE_MODE=local`
  throws and exits `1`; previously it matched the blanket local-mode skip and exited `0`, so a
  wrapper script that checked the exit code alone could not tell "skipped" from "uploaded".

### Fixed

- **A stale publish can now be repaired.** `pnpm drive:publish` re-uploads an item whose content
  changed after it was published, updating the file in place — for Google Drive its id and share
  link (and any link already recorded in the Sheet `history` tab) are preserved; for the `local`
  target `LocalFileUploader.update` does the equivalent. Previously `pnpm status` could report an
  item as `stale` with no way to resolve it. Google Drive and `local` only; Lark Drive has no
  content-replace endpoint, so a stale item there is reported as a failure. Items published before
  the sync ledger existed carry no content hash and are never re-uploaded.
- **Lark collection (B)** — incremental re-runs no longer re-collect the boundary message. Lark's
  `start_time` filter floors to the second and is inclusive, so the API re-returned the message at
  the exact watermark instant on every run (reported as `collected 1` with no new data). The gateway
  now drops anything at or before the ms-precise watermark client-side, mirroring the X collector.
  Verified live: the Lark bot's `im:message.group_msg` scope is approved, `collect-lark` reads group
  messages, and a no-new-data re-run now reports `collected 0`.
- **Artifact paths are anchored to the repo root**, not the process CWD. Running a command from a
  subdirectory silently created a second `output/` tree; all 36 path literals now come from
  `src/paths.ts`.
- **`prepare` no longer strands an unsaved batch.** `translate:prepare`, `convert:prepare` and
  `format --refine` archive the previous `pending.json` before replacing it and write it atomically
  like every other store; `translate:save` and `format:save` fall back to an already-saved item
  instead of throwing.

## [0.1.0] - 2026-07-15

Initial release: the end-to-end Mantle KR content pipeline
(collect → translate → review → publish), subsystems A–E, run locally per operator.

### Added

- **X data collection (A)** — Incremental tweet collection via twitterapi.io with a
  keyed per-handle watermark, soft-mark deletion, and conversationId thread grouping.
  Collect stops client-side at the watermark and caps pagination.
- **Lark data collection (B)** — Message collection over the Lark IM API on shared
  HTTP/store infrastructure. (Code + tests; live verification pending Lark app approval.)
- **Korean translation (C)** — Source-agnostic `ContentItem` model and an agent-assisted
  translation flow with living steering config in `translation/` (glossary, style guide,
  locale, few-shot). `translate:prepare` → agent fills the worksheet →
  `translate:save [--approve]`, with approved translations feeding the few-shot flywheel.
- **Drive upload (D)** — Headless Markdown publishing to Google Drive and Lark Drive:
  review docs (source + Korean) for translated items, Korean-only for approved.
  Descriptive filenames `<date>-<slug>-<id>.md`, per-drive idempotency, and failure
  isolation. `drive:init` provisions and shares the folders.
- **Review dashboard (E)** — Local web tool (`build:web` + `serve` → localhost) with a
  `node:http` JSON API over the existing use-cases and a React + Vite + Tailwind v4
  frontend to list, filter, edit, approve, and publish translations.
- **Google auth** — Selectable OAuth user-delegation and service-account strategies
  behind a shared `TokenSource`, plus `google:auth` for one-time OAuth consent.

### Changed

- Renamed `data/` → `translation/` to better describe the translation steering config.
- Reorganized `output/` into per-stage subfolders (`x`, `lark`, `translations`, `publish`).
- `drive:publish` defaults to `--target google` (Lark is opt-in).

### Fixed

- Collect stops at the watermark instead of crawling the full account history
  (advanced_search ignores `since_time`), cutting a run from ~12 min to ~2 s.
- Collect no longer aborts on a tweet missing `author.userName`.
- Google Drive uploads use OAuth for personal Gmail accounts, working around service
  accounts having no storage quota (403 `storageQuotaExceeded`).
- `google:auth` CLI no longer crashes on a late loopback request after the server begins
  closing (`server.address()` returned `null`).
- Dashboard server returns 500 safely instead of crashing when a response fails to serialize.

[Unreleased]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kyle-park-io/mantle-kr-herald/releases/tag/v0.1.0
