# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

Defaulting it was considered and rejected. Defaulting to `local` would let a cloud operator run
`drive:publish`, see `local mode — skipped` and **exit 0**, and believe work reached Drive when
nothing was uploaded — the exact failure the explicit mode exists to prevent. Failing loudly once
is the cheaper outcome.

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
  skips the Drive/Sheet commands with a clear message; collection still needs a key for whichever
  source you use (`TWITTERAPI_IO_KEY` for X, the Lark app credentials for Lark), independent of
  storage mode. `cloud` behaves as before. Storage mode is never inferred.
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
  `approvedAt`'s date), the local uploader writes the new file and then moves the old one out of
  the way, so a re-approved item ends up as exactly one document on disk — mirroring the Drive
  PATCH that updates content in place while preserving a file id.

### Changed

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

[Unreleased]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kyle-park-io/mantle-kr-herald/releases/tag/v0.1.0
