# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`pnpm glossary:mine [--notify]` — which terms are still waiting on a glossary *decision*.**
  `translate:check` measures translations against decisions already recorded and is, by construction,
  silent about a term nobody has decided; that silence was the actual bottleneck. Prototyped by hand
  against production on 2026-08-11: ten proposals, all ten applied, glossary 96 → 106 entries in an
  afternoon — not because anybody lacked a place to type them, but because nobody knew which ten
  terms to type. **No UI**, deliberately. Three signals, all pure and unit-tested in
  `src/domain/translation/glossaryMining.ts`: un-glossed proper nouns the English source repeats
  (≥2 occurrences), word-level substitutions a human made between our draft and the published post
  (**no frequency threshold at all** — the run's best find, `낸슨 → 난센`, occurred exactly once, and
  an earlier attempt requiring three found nothing), and cross-validation of both against the
  @0xMantleKR reference corpus. **The cross-validation is a discriminator, not decoration:** when the
  human's edit has zero corpus occurrences while our draft's form has two or more, the edit was a
  one-off and our draft was right — that rule threw out `시장 가격→시장가` (2:0) and `규모→사이즈`
  (13:0), both of which would otherwise have entered the glossary as wrong renderings, while
  deliberately keeping `낸슨 → 난센` (0:0, no evidence either way). Rejections are listed in the
  review file with their numbers rather than dropped. Counting strips `@handles` and links first,
  which is load-bearing: `Nansen` matches the real corpus six times and every one of them is
  `@nansen_ai`. Output is one file — `$OUTPUT_DIR/glossary/candidates-<YYYY-MM-DD>.json`, in the same
  shape the human filled in and applied — and its **absolute path** is on stdout and in the alert,
  because the scheduler writes under `~/.herald/output` while a hand-run writes under the checkout's
  own `output/`. Read-only otherwise; exit 0 always.
- **`translation/glossary-dismissed.json` — the "no" that makes a repeating report converge.**
  `glossary:mine` has no cursor and no seen-state, so without somewhere to record a rejected
  candidate the same line arrives every Monday forever, which is precisely the failure
  `translate:check --notify` was designed around when it refused to page on drift. Hand-edited only —
  nothing in the pipeline may write it, or a run could silence its own findings. It is **steering
  config**: `isSteeringConfigFile` accepts it, so `config:push`, `config:pull` and `deploy:freeze`
  carry it with the glossary it belongs to (pinned by a test, because "accepts everything that isn't
  an example or a few-shot export" is a rule somebody could later narrow into an allow-list).
- **The reference corpus's own staleness is now reported rather than assumed.** `collect:reference`
  is manual by design — collecting weekly would spend twitterapi.io budget on data that is
  overwhelmingly historical — so `glossary:mine` reads coverage out of `x/reference/runs.json`
  (widest `covered.to` across runs, never the last entry's: a `--since` backfill appended after an
  incremental run covers older ground while being newer in the file) and says so in stdout *and* the
  alert when the newest content is more than 28 days old. A missing corpus, an unreadable run ledger
  and a stale one all **cap every candidate at tier B** rather than silently grading on less
  evidence, and a corrupt corpus file degrades with a printed warning instead of failing the run.
  A clean week stays silent even on a stale corpus: the corpus only ever *grades* candidates, it
  never produces one, so there is nothing a stale corpus could be hiding.

- **`pnpm doctor` now says whether the steering config the *scheduler* runs with is still the one
  this checkout holds — a new `Steering deploy sync` line.** Since 0.5.0 the deploy checkout's
  configuration is a copy taken at deploy time rather than a symlink, which closed one exposure and
  opened a quieter one: `pnpm glossary add` or `pnpm tm:promote` with no `bash deploy/herald-deploy.sh`
  after it leaves the timers translating against the old glossary, and nothing anywhere reports it —
  a term that was never applied does not look wrong, it is simply absent. The comparison is the
  deploy gate's own (`src/deploy/steeringSnapshot.ts`, lifted out of `deploy-freeze.ts` so a second
  command could reuse it instead of reimplementing it), so the two cannot disagree: one
  `steeringFilesIn` — `git check-ignore` narrowed by `isSteeringConfigFile`, few-shot carve-out and
  all — one pair of opposite symlink rules, one set of sha-256s, and the same rule that **only names
  are ever printed**. **The deploy path is not in `src/` and never will
  be** — doctor asks systemd for `herald-watch.service`'s `WorkingDirectory`, which is what the
  scheduler actually runs from and needs no configuration on the machine that has one; `.env`'s new
  `HERALD_DEPLOY_DIR` states it explicitly where there are no units to ask, and wins where both
  exist. **Drift is a `warn`, never a `fail`** (the minutes between an edit and its deploy are the
  intended state, and a check that exits 1 on healthy work gets switched off), and the three ways the
  question cannot be answered from here each say "not applicable" in their own words rather than
  implying agreement: no second checkout is identified (every fresh clone, every CI run), doctor is
  running *inside* the deploy checkout (the tree it was copied from is known to `herald-deploy.sh`
  and to nothing in `src/`), or this checkout holds no steering config of its own (a git worktree —
  the check above already grades that, and reporting it twice would name an empty worktree the record
  of truth). Both paths appear in the drift line, labelled: which tree is the source and which one
  the schedulers run flips depending on where you typed the command. **The grading is by direction,
  not by "the diff is non-empty":** files the deploy tree holds and this checkout no longer syncs are
  their own `ok` state, worded as something the next deploy sweeps rather than as a fault, because
  nothing the scheduler reads is affected by them. That state is not hypothetical — it is what every
  machine deployed before the few-shot carve-out above reports on its first run, seven files' worth,
  and grading it ⚠ would have made the check's debut a false alarm about files nothing reads.
- **A fifth scheduled unit runs the weekly glossary digest — `herald-translate-check.timer`,
  Monday 06:53 — and it carries two commands, not one.** `pnpm translate:check --notify` asks whether
  the glossary's decisions were kept; `pnpm glossary:mine --notify` (below) asks what has never been
  decided. Weekly and not daily, because neither report has a cursor: both re-read the whole ledger
  and re-report every standing finding, and their inputs only move when `x:reconcile` captures a
  published text or a human edits the glossary. A daily fire would re-send the same lists six extra
  times a week, which is how an ops room becomes noise people stop reading. One `Type=oneshot` unit
  rather than a sixth timer: the two are halves of one question read in one sitting, and a oneshot
  runs multiple `ExecStart=` lines in order — stopping at the first failure, which is right, since
  both need the same database and the same glossary. `TimeoutStartSec=840` is sized by the alert path
  rather than the work, and by the *number of alerting commands*: `notifyOps` calls `fetch` with no
  timeout of its own, so an unanswered Telegram send runs to undici's 300s ceiling, reaching it is
  the *good* outcome (the send is swallowed, the run still exits 0 with its report intact), and each
  command makes its own send — 120 + 300 twice over. **Installing it means copying eleven unit files
  now, not nine** — the runbook's `cp` block is the complete list, and
  `systemctl --user start herald-translate-check.service` is safe to run by hand as its own dry run,
  unlike `herald-x-reconcile.service`, because these commands only read.
- **`pnpm translate:check --notify` sends one ops-room alert when the published posts overrode a
  decided glossary term — and only then.** The override list is the half of that report that goes
  stale in a direction that matters: a term the humans keep taking back out stays wrong in
  `translation/glossary.json` until somebody looks, and nobody reads a timer's journal. The alert
  names the term, what the glossary decided, and **how many items it was overridden in** — the count
  is the argument (one item is an anecdote, four is a pattern), so the item ids and the post text
  stay out and it stays readable on a phone. Glossary **drift** deliberately never pages: the
  command prints "not every line is a defect" under that list because a term inside a quoted English
  sentence lands there routinely, and paging on it would train the room to ignore the alert. Off by
  default — without the flag the command is byte-for-byte what it was, stdout and exit 0 — and it
  still exits 0 when it does page, including when the send fails. The message is built by
  `overrideNotification` (`src/cli/translateCheckReport.ts`), pure and pinned in
  `tests/cli/translateCheckReport.test.ts`, for the reason `xReconcileReport.ts` exists: a top-level
  script has no coverage of its own, so its load-bearing wording cannot live inside it.
- **Both review sidebars have a search box under their filter tabs, and it understands Korean the way
  a Korean keyboard produces it — `ㅁㅌ` finds 맨틀, and so does every state the IME passes through on
  the way there (`매`, `맨`, `맨ㅌ`, `맨트`).** The tabs answered "what is left" but never "where is
  that one item", so the only way to reach a specific row in a `w-80` column was to scroll it. 1차
  searches the itemId and both languages of the body — `koreanText` *and* `sourceText`, so a
  translated row is still reachable by the English word you remember — and its tab counts now count
  the searched set, keeping the contract `TranslationList.tsx` already wrote down: a tab must never
  promise a row it does not then show. 2차 searches every card an item still has after the
  status/channel/type filters, not just the one the preview happens to show, because the row stands
  for the whole board it opens. The matcher (`web/src/hangulSearch.ts`) is one compiled regex per
  keystroke and no new dependency: a Hangul syllable's codepoint is `0xAC00 + 초성×588 + 중성×28 +
  종성`, which makes "every syllable starting with ㅁ" a contiguous range, and makes "this last letter
  is still being composed" one too. Handling the composing states is not a nicety — React's
  `onChange` fires with the in-progress value, so a matcher that ignored them would blank the list
  mid-word on every search.
- **The dashboard's `local`/`cloud` badge now says whether the deployment's credentials still ANSWER,
  not merely that they exist — and a ⚠ chip appears beside it only when one of them stopped answering,
  or when nothing has asked in over a day.** On 2026-08-10 the deployment's Google, Typefully and
  Telegram credentials answered 401 for four days while the header showed every key `설정됨`, and that
  display was correct rather than broken: presence is all `/api/status` could see (`createDeps.ts`:
  "env only, no live calls"). `pnpm deploy:smoke`
  learned to catch this at deploy time and `pnpm creds:check` under `herald-creds.timer` learned to
  catch it between deploys, but both answers ended in a terminal and in a systemd journal this box
  rotates every eight minutes — never on the screen the team actually watches. This is the same fact,
  on that screen. **Existing installs need `pnpm db:migrate`** for the new `credential_liveness` table;
  `deploy/herald-deploy.sh` already runs it on every deploy. `/api/status`'s own read degrades to
  showing nothing rather than to a 500, but an unmigrated database does not stop there:
  `credential_liveness` is now one of `TABLE_NAMES`, so `isSchemaApplied` fails without it and `pnpm
  doctor`'s Database check turns red with `Schema not fully applied — a column applySchema adds is
  missing` — naming a missing *column* when what is actually missing is this new *table*. `pnpm
  db:export`'s preview prints its own `Schema not applied yet` line for the same reason.
  - **The route that probes is the only thing that writes**, so every caller that already existed fills
    the row for free — no new unit, no new command, no change to `herald-creds.service`. `GET
    /api/diagnostics/live` records the seven results it just took into one upserted row
    (`credential_liveness`: `id`, `probes`, `observed_at`), which makes the badge show whatever asked
    last: the daily `creds:check`, any `pnpm deploy:smoke`, or the card's own `[지금 확인]`.
    `creds:check` deliberately does not write it itself — that command talks to the deployment over
    HTTP precisely because the deployment's credentials cannot be read from outside (`--sensitive`
    values never come back), and a CLI reaching into production Postgres to record what it learned over
    HTTP would re-open the coupling the HTTP call exists to avoid, writing with whatever `DATABASE_URL`
    the operator's `.env` happened to hold. `pnpm doctor --live` writes nothing at all: it probes this
    machine's `.env`, which has no business landing in a row that claims to describe the deployment.
  - **The write is best-effort and bounded at two seconds**, because a diagnostic that fails to answer
    because it could not record its own answer is the same mistake as one that 500s because a probe
    failed. A try/catch alone was not enough: the `pg` pool behind it sets no `connectionTimeoutMillis`
    or `statement_timeout`, so a database that stalls rather than errors — pool exhaustion, a
    blackholed connection, Neon mid-restart — would have held the route open past `runLiveProbes`' own
    5-second deadline, and an unbounded hang is precisely what `deploy:smoke` cannot tell apart from a
    deployment too old to have the route. Two seconds is one indexed single-row upsert plus the "few
    hundred milliseconds" Neon's own docs give for waking a suspended compute, with the function
    (`sin1`) and the database (`ap-southeast-1`) in the same city.
  - **`/api/status` gained one single-row read and no outbound call of its own.** The refusal written
    into `apiHandlers.ts` stands — the board calls that route on mount, on every login, and after each
    approve, unapprove, retire, unretire and publish, and "six external calls per board render would be
    a different bug" — so the payload carries a summary of what was *already* observed, beside the
    seven reads `loadStatus` already makes. `liveness` is optional the way `dbEnv` and `sendsEnabled`
    are: absent means nothing has ever probed this database, or the table is not there yet, and both
    render as the header did yesterday rather than as an error or as an all-clear.
  - **Severity is the same table `deploy:smoke` prints, applied once and on the server.** A dead
    publishing credential (Google auth, either Drive folder, Lark) is red, a dead send credential
    (Typefully, Telegram) follows `HERALD_SENDS_ENABLED` — red when sends are open, amber when they are
    closed — the Sheet is header links so it only ever ambers, and an unconfigured integration is
    neither. `PROBE_TIER`/`liveSeverity` moved out of `src/deploy/smokeChecks.ts` into
    `src/doctor/liveSeverity.ts`, beside the `ProbeKey` they are keyed on, so the two graders that
    exist — `smokeChecks.ts` for a terminal, `src/status/liveness.ts`'s `summarizeLiveness` for a
    request — read one table instead of one of them importing out of the other's directory. The
    browser re-derives none of it: it is handed `worst`, and `tier`/`severity` per dead credential, and
    only picks the wording and the colour — a card that did its own arithmetic is exactly how the CLI
    and the header drifted apart the last time. So a credential that fails a deploy and the same
    credential on the board cannot disagree about how serious it is.
  - **Nothing renders at all when a fresh observation found everything alive**, and the header stays
    byte-identical to before: an indicator that is green 364 days a year is one nobody reads on the
    365th. When something is wrong the chip names the worst tier and how many of it died
    (`⚠ 발행 키 1개 응답 없음`), and the hover card gains a `키 응답` section under its existing
    `설정됨`/`키 없음` list — a headline (`7개 모두 응답 · 2시간 전 확인`, or `7개 중 1개 응답 없음 ·
    …`), a line per dead credential naming it in Korean beside the reason, and a `[지금 확인]` button
    that re-probes the deployment and re-reads the status. The reason is carried rather than summarised
    because it is the distinction that mattered on 2026-08-10: `400 invalid_grant` means the token is
    dead, `401` means the client credentials do not match, and re-minting on a 401 loops forever. A
    failed check appears inline in the card and leaves the stored observation on screen — the last
    known truth being more useful than a blank — and it appears there on a deployment that has never
    been probed too, which is the install this button helps most and the one where an unreported
    failure would have been silent.
  - **A stale observation reads amber with a time, never red with a key name.** Twenty-six hours,
    derived from `herald-creds.timer`'s daily 06:23 fire the way `REPORT_STALE_AFTER_MS` is derived
    from `herald-watch.timer`: one missed fire plus margin. Worth showing because the unit's own
    `OnFailure=` hook cannot cover the case that matters — when this machine is simply off nothing
    fails, no Telegram arrives, and the board is the only place the silence shows. Stale is not
    evidence that anything is wrong; it is evidence that nothing has looked, which is why it never
    borrows the colour a dead credential uses. Ages past a day read coarsely (`⚠ 확인 1일 전`), since
    the age formatter the 수집 card already uses buckets by whole days rather than growing a second one.

### Changed

- **Translation-memory pairs are now picked by the *proportion* of anchors they share with the
  target, not the raw count — so one long post stops being the precedent for everything.** Anchors
  (cashtags/hashtags/mentions) are the signal that ties an EN post to its KO translation, but a post
  that name-drops fifteen projects shares an anchor with almost anything, and the raw count made that
  breadth look like relevance. In the live ten-pair `tm.json` anchor count tracks pair size almost
  exactly — 62 anchors/22,976자, 47/4,939, 30/2,291, … 2/581 — and the 62-anchor pair is a **monthly
  recap thread**, a lede plus fifteen numbered blurbs. It was a precedent for 8 of the 14 recorded
  drafts that share any anchor at all. That is worse than its bulk: the alignment pass's whole
  instruction is "match the phrasing and terminology of the 선례", so a recap's register was being
  taught to ordinary posts. `anchorSimilarity` (`src/domain/tm/anchors.ts`) now scores **Jaccard over
  the two anchor sets**, `|shared| / |union|` — the same measure `lexicalSimilarity` next door already
  uses over content tokens and `kol/attribution.ts` uses over character 3-grams, rather than a third
  scheme. Not `|shared| / |candidate anchors|`, which would only mirror the bias: it scores a 1-of-1
  coincidence 1.0 and an 8-of-10 match 0.8. **Measured on the real corpus:** the one
  alignment-eligible draft of 2026-08-11 goes from a 28,521자 precedent block led by the recap to
  2,369자 without it; the recap's presence across recorded drafts falls 8/14 → 5/14. For the batch
  translation prompt the gain depends on batch width, because the batch's anchor *union* sits on the
  denominator for every candidate alike: a 5-item batch goes 32,636자 → 15,524자 and a single
  two-anchor item 17,379자 → 13,046자, while a full 20-item `translate:prepare` batch (41 distinct
  anchors) selects the identical six pairs as before. **Nothing else about selection moved**: Jaccard
  is positive exactly when the raw count was, so the `> 0` filter admits and rejects the same
  candidates and only reorders them — which is why `selectPrecedents`'s lexical fallback still fires
  for exactly the same drafts (15 of the 26 recorded translations, before and after, attaching 0
  precedents in both because every remaining pair scores under `LEXICAL_MIN_SIMILARITY`) — and ties
  still resolve to input order, so two runs cannot hand the alignment pass different worksheets.

- **The steering sync no longer treats `db:export`'s few-shot files as configuration.**
  `translation/few-shot.json` and `conversion/few-shot.<type>.json` are git-ignored and sit in the
  steering tree, so both derived lists — `FsConfigFileStore.list()` (every non-`.example.` file) and
  `deploy:freeze` (every `git check-ignore` hit) — called them config and shipped all seven: into the
  Drive bundle on `config:push`, and into the deploy checkout the scheduler runs from. Since the
  hosted-writes cutover the corpus is the `few_shot_examples` table; nothing reads those files at
  runtime, so what shipped was a snapshot frozen at cutover, reported as success. `db-import.ts`'s
  own doc comment had predicted exactly this. **They are not deleted** — `db:export` writes them and
  `db:import` reads them, and that is the documented rollback path, untouched here. A shared
  `isSteeringConfigFile` (`src/domain/config/steering.ts`) is now the one place that separates the
  two kinds, used by `config:push`/`config:pull` and `deploy:freeze` alike. `translation/tm.json` is
  the near miss the predicate is written around: it is a `FewShotStore` in the code too, but
  `translate:prepare` and `translate:align` genuinely read it, so it keeps syncing. `config:pull`
  also drops these paths out of an *incoming* bundle, since every snapshot pushed before this change
  still carries them and would otherwise write a stale corpus back for `db:import` to resurrect. The
  deploy side of the freeze listing is deliberately left unfiltered, so copies earlier deploys
  already froze show up once as `- ` removals and are swept rather than sitting there forever.

### Fixed

- **The hosted board no longer offers a `[local]` 발행 button, and refuses the request outright if
  one is sent anyway.** The button was live on Vercel and did something worse than nothing: `local`
  resolves to a `LocalFileUploader` writing under `paths.publishLocalDir`, and inside the Function
  `REPO_ROOT` is `/var/task` (the bundle Vercel runs is `dist/api-entry.js`), which is read-only —
  so a click spent a round trip to attempt a write that could not land. Nothing said so, either:
  `PublishTranslations` records each uploader's error into `result.failures` rather than rethrowing,
  so the route answered **200** and the board rendered a dead publish as an ordinary attempt that did
  not take. Even a successful write would have been pointless there — `GET /api/publish/local/*`, the
  route that reads those files back, is served by `HttpServer.ts` outside `handleApi`, so the hosted
  entry point has no way to serve one, and the instance's disk leaves with the instance.
  - **Fixed where the deployment is known, not where the target is parsed.** `createDeps.ts` computes
    one `localPublishEnabled` boolean from `routes` and uses it for BOTH `StatusView.availableTargets`
    (which is the only thing that enables the button) and `publishOne`'s own refusal — the same
    "computed once, used for both" pairing `sendsEnabled` and `conversionEnabled` already use, so an
    offered button and an accepted request cannot disagree. `resolveTargets` was the wrong layer: it
    keys on the storage MODE, and hosted's mode is `cloud`, the correct value — the same blind spot
    that let `assertCloudStorage` (which checks the mode once at startup) miss this. Tightening it
    there would also have broken `pnpm drive:publish --target both,local`, a real CLI use that keeps
    a readable copy on the operator's own disk beside the Drive upload.
  - **A request that still names `local` throws rather than returning a result.** That is the
    difference between a 500 carrying a sayable reason and the 200-with-a-swallowed-failure this
    replaces. **The local board is untouched**: `pnpm serve` builds `routes: "local"`, the target
    stays in `availableTargets`, the button stays live, and the write lands in `output/publish/local/`
    exactly as before.
- **Documentation that had drifted from the code.** `skipIfLocal` gates nine commands, not seven —
  `x:reconcile` and `x:link` were added after the docs were written (`docs/ko/env.md`,
  `docs/ko/artifacts.md`, `docs/ko/quickstart.md`, `.env.example`), and the two new ones now carry
  the "`local` 모드면 스킵" note in the command table like the other seven. `pnpm status` was
  documented as reading `output/` files without consulting the storage mode; the mode half was right
  but it reads the database exclusively through `createStores(db)`, which is also why it fails
  outright on an unmigrated database. `docs/ko/env.md`'s `HERALD_STORAGE_MODE=local` bullet said
  everything lives under `output/`, contradicting the `DATABASE_URL` box six lines above it that
  correctly says the ledgers are in Postgres in either mode. `docs/ko/artifacts.md` §3's command
  table names pipeline ledgers by their `output/*.json` export filenames, which now has a note at the
  top of the table saying so — and the formatting-stage rows, which named the files as files, name
  `PgConversionStore`/`PgTranslationStore`/`PgFormattingStore` instead (their `pending.json`,
  worksheet and archive halves were accurate and are unchanged). `docs/ko/capabilities.md` used "8"
  for two different things one sentence apart: `PrepareTranslations` still takes the last 8 curated
  few-shots, and what the TM work replaced was the rule that those 8 were *all* the prompt got.
  `.vercelignore` cross-referenced `createDeps.ts:356` for the `conversionEnabled` guard, which has
  since moved — replaced with a search anchor rather than another line number. And
  `docs/ko/setup/steering.md` said `pnpm doctor` "only checks that the file exists": it has checked
  content since `skeletonSteeringFiles` landed, warning on an empty glossary or a guide still
  identical to its skeleton.

## [0.5.0] - 2026-08-11

### Upgrading — action required for existing installs

- **Run `pnpm db:migrate` against every database this install touches — production first, and before
  you redeploy the dashboard.** This release adds three columns to a table every prior install
  already has (`translations.posted_url`, `.posted_at`, `.published_text`) and one new table
  (`translate_floor_reports`). Columns do not announce themselves the way a missing table does:
  `src/adapters/store/PgTranslationStore.ts` names all three in a plain `select`, so an unmigrated
  database fails on *every* read of `translations` — the review list, `pnpm status`, `pnpm watch`,
  `pnpm x:reconcile` — with `column "posted_url" does not exist`. That is exactly how it was found,
  against the real production database on 2026-08-07. Only `pnpm serve`, `pnpm db:import` and
  `pnpm db:export` apply the schema themselves; **the Vercel entry point cannot**
  (`src/app/createDeps.ts`), so a hosted deployment redeployed ahead of the migration serves 500s
  from the review screen. `db:migrate` is safe to re-run and has no `--yes` gate — every statement is
  `create table if not exists` / `alter table ... add column if not exists`, so it can only add
  schema. `deploy/herald-deploy.sh` runs it on every deploy, so the scheduler's production database
  is covered by the step below. `pnpm doctor`'s `Database` line is column-aware now, so it will tell
  you before any other command does.
- **`git pull` alone now puts unreleased code into production, because the installed
  `herald-watch.service` still runs out of the development checkout — stand up the deploy checkout
  and reinstall the units, in that order.** Until this release a unit's `WorkingDirectory=` was
  `/home/kyle/code/mantle-kr-herald`, so whatever was checked out there *was* what the timer ran. It
  is `%h/.herald/app` now — merged `main` only, moved by nothing but `deploy/herald-deploy.sh`. The
  one-time setup must happen before the unit files are copied, because their `ExecStart=` points into
  that directory ([`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §6):

  ```bash
  mkdir -p ~/.herald && chmod 700 ~/.herald
  git clone --branch main <this repo> ~/.herald/app
  mkdir -p ~/.herald/bin
  ln -sfn "$(which node)" ~/.herald/bin/node
  ln -sfn "$(which pnpm)" ~/.herald/bin/pnpm
  bash deploy/herald-deploy.sh          # stops at the config gate, exit 2 — this is expected
  bash deploy/herald-deploy.sh --yes    # once the printed list of names looks right
  ```

  The units reach node and pnpm through `~/.herald/bin` rather than an nvm version directory, because
  nvm *deletes* the old directory on upgrade: a 2026-08-09 rebuild of this box came back on v24.19.0
  while every unit still said v24.14.0, and each fire after that died with `203/EXEC` before running a
  line — the timer kept firing, every fire failed identically, and the only signal was the failure
  alert. After a node upgrade, re-run the two `ln -sfn` lines and leave the units alone. The first
  `herald-deploy.sh` always stops: there is no previous snapshot to diff against, so every variable
  name and steering file prints as `+`. Values are never printed, only names.
- **Copy all nine unit files and delete `~/.config/systemd/user/herald-notify-failure.service` — copy
  without deleting, or skip this, and the failure alert stops arriving with nothing to say so.** The
  `OnFailure=` hook is templated now (`herald-notify-failure@.service`, taking the failing unit's name
  through `%n`/`%i`) because four scheduled units share it and a hardcoded name meant three of them
  reported `herald-watch.service`'s journal on their own failure. The old wrapper invokes
  `deploy/herald-notify-failure.sh` **with no argument, out of the development tree** — so this pull
  swaps the new script under the unit systemd already has, and the new script refuses an empty `$1`
  with exit 1 rather than sending a message that names no unit. Nothing breaks loudly: the timers keep
  firing, the pipeline keeps running, and the one thing that would have told you a scheduler died is a
  `herald-notify-failure.service` sitting in `systemctl --user --failed` that nobody is looking at.
  Copy the whole list even to install one unit — an identical file is just an overwrite:

  ```bash
  cp deploy/herald-watch.service deploy/herald-watch.timer \
     deploy/herald-convert.service deploy/herald-convert.timer \
     deploy/herald-x-reconcile.service deploy/herald-x-reconcile.timer \
     deploy/herald-creds.service deploy/herald-creds.timer \
     deploy/herald-notify-failure@.service \
     ~/.config/systemd/user/
  rm -f ~/.config/systemd/user/herald-notify-failure.service
  systemctl --user daemon-reload
  ```

  `daemon-reload` is where this block ends. `enable --now` is per unit and each has its own gate to
  clear first — `herald-x-reconcile.service` carries `--yes` in its `ExecStart=`, so starting it by
  hand is not a rehearsal, it is the first production write.
- **The scheduler's configuration is a deploy-time copy now, not a symlink — editing the development
  `.env` or a steering file no longer reaches production.** Until this release the deploy checkout's
  `.env` was a symlink into the development tree, so production read the development checkout's
  configuration fresh at every timer fire: the exposure the deploy checkout closed for code was still
  open on the config axis. `pnpm deploy:freeze` takes the copy, prints what would change **by name
  only, never by value**, and stops unless `--yes` says the change was intended. Two consequences: a
  steering or `.env` fix is live only after `bash deploy/herald-deploy.sh --yes`, and a rehearsal
  value left in the development `.env` will be carried into production by the next deploy — the gate
  names it, which is the point.
- **`HERALD_TRANSLATE_SINCE` moves one second, to `2026-07-27T14:35:25.000Z`, when you reinstall
  `herald-watch.service` — and if you are reinstalling on a box that has been collecting, do not
  raise it to meet your watermark.** `applySelector` compares `item.createdAt >= since`, so a floor
  set *at* a post's own timestamp still selects that post; the extra second excludes exactly the one
  item dropped as stale on 2026-08-06 and nothing else. On a reinstall, `floor < watermark` is the
  correct state — the gap is a queue, not a hole. Raising the floor to the watermark permanently drops
  everything `pnpm status` counts as `in scope`: already collected, not yet translated. That was 20
  items on 2026-08-10 ([`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §6).

### Added

- **`pnpm deploy:smoke` now proves the deployment's credentials are still ALIVE, not merely present
  — and `pnpm doctor --live` and the deployment run the identical probe code to do it.** Nothing in
  the repo could tell a revoked token from a live one, and the gap produced two incidents rather than
  one. On 2026-08-04 a rehearsal ran for an hour with `pnpm doctor` reporting `✓ Google Drive
  configured` while every refresh returned `invalid_grant`. On 2026-08-10 revoking a leaked refresh
  token revoked the grant with it, so the deployment's own copy died too — `deploy:check` passed
  (40 ok · 1 warn · 0 fail), `deploy:smoke` passed (21 ok · 2 warn · 0 fail) and reported
  `availableTargets: google — present`, and both were correct and both were useless. The failure was
  found only because we had caused it. Neither command could have seen it, and not by oversight:
  `deploy:check` reads variable *names* out of `vercel env ls` (`--sensitive` values cannot be read
  back at all, and reading the rest would write production secrets to disk), the deployment's status
  payload is presence by construction (`createDeps.ts`: "env only, no live calls"), and `deploy:smoke`
  reads that payload. Liveness is observable from exactly one place — inside the deployment, where the
  credential is — so it is now probed there and asked for from outside.
  - **One module, two callers, no second copy.** `src/doctor/liveProbes.ts` holds every probe and the
    environment→input step both callers need; `pnpm doctor --live` and the deployment's
    `probeLiveness` each call it in one line. A second implementation would drift from the first and
    the drifted one would be the copy running in production — concretely, a copy regressing from
    `loadLarkAppConfig()` to `loadLarkConfig()` (which additionally wants LARK_CHAT_IDS, deliberately
    unset on the deployment) makes the hosted Lark probe report `skipped` forever, and a skipped probe
    grades ok. Seven probes: the Google token refresh, the review and approved Drive folders
    separately, the Sheet, Lark's tenant token *and* whether the bot is still in a room, Typefully,
    and Telegram's `getMe`. `twitterapi` is deliberately not probed — the deployment never collects
    and its key is intentionally absent, so probing it would manufacture a failure out of a correct
    setup.
  - **`GET /api/diagnostics/live`, behind the session like every route but login.** Deliberately not
    a field on `/api/status`: the dashboard calls that on every load, and six external calls per board
    render would be a different bug. It answers **200 with the report even when every probe is dead**
    — a diagnostic that 500s when something is wrong is no diagnostic — and the caller judges.
    Severity is by what the credential is FOR, not by which API answered: a dead publishing credential
    (Google auth, either Drive folder, Lark) is a **fail**, a dead send credential (Typefully,
    Telegram) follows the `sendsEnabled` flag the same payload already carries, and the Sheet is
    header links so it only ever warns. An unconfigured integration is neither — presence is
    `deploy:check`'s job, and a Telegram-only install must not go red because Lark Drive is absent.
  - **No probe's output can carry a credential, and that is enforced by walk rather than by
    discipline.** Every string leaf of every result — `detail`, each granted scope, a Drive folder's
    name, Typefully's `resets_at`, Lark's `msg` — is redacted before it leaves the module, on the
    return path as well as on throw, against a secret set that includes the two tokens obtained
    mid-run (Google's access token, Lark's tenant token). This is load-bearing rather than tidy: the
    route holds every live secret the deployment has, its body crosses the network into a terminal and
    a CI log, and the Telegram bot token is in a URL path that `fetch`'s own error messages quote.
  - **One 5-second deadline for the whole run**, not one per request. Per-request timeouts bound
    nothing a caller can promise — the probes that take a signal each got a fresh one, and the Google
    token closure took none at all (measured still hanging at 6009 ms against a budget of 1000). All
    seven now start together under one deadline, every `fetch` gets a signal for what is left of it,
    and each probe is bounded by the same remainder, so a function that ignores its signal cannot hold
    the run open either. On the deployment that is the difference between a 5-second answer and a
    platform 504, which reads to the caller as "an old deployment without the route".

- **`pnpm deploy:freeze --check|--apply` — the scheduler's configuration is now a snapshot taken at
  deploy time, not a live window into the development checkout.** The 2026-08-07 outage was fixed by
  giving the scheduled units their own code checkout; configuration never got the same treatment.
  `~/.herald/app/.env` was a symlink into `~/code/mantle-kr-herald`, and `herald-deploy.sh` linked
  every git-ignored file under `translation/`, `conversion/` and `keys/` the same way — so
  `TELEGRAM_CHAT_ID_*`, `TYPEFULLY_API_KEY`, every `GDRIVE_*`, the glossary, the style guide and the
  conversion prompts were, at the moment a timer fired, **whatever the development checkout said
  right then**. Point a chat id at a scratch room to test something and the 18:41 fire delivers
  production copy there; pull a glossary update mid-edit and the next tick translates against a
  half-written one. Unlike code, this needed no checkout, no merge and no deploy — editing a file was
  enough. The three units' `WorkingDirectory` and `~/.herald/prod.env` are untouched: shell
  environment still beats Node's `--env-file`, so `prod.env`'s two lines still override the copy's
  local-Docker `DATABASE_URL`.
  - **Two phases, because the gate has to run before anything destructive.** `--check` is read-only
    and prints a **name-only** diff between the deploy checkout's current snapshot and the
    development checkout — `+ NAME` / `~ NAME` / `- NAME`, never a value, pinned by a test that puts
    a secret-shaped string in both inputs and asserts it never reaches the output. It exits 2 unless
    nothing changed or `--yes` is passed, and `herald-deploy.sh` forwards its own `"$@"` to it, so
    the human-typed command stays `bash deploy/herald-deploy.sh [--yes]`. It runs **before** the
    `git reset --hard`, not next to the copy: refusing after the code has already moved is precisely
    the half-finished deploy that script's header rules out. `--apply` then writes, after
    `pnpm install`, to a temp name in the destination and renames, so an interrupted deploy leaves
    each file wholly old or wholly new. `.env` and everything under `keys/` are written `chmod 600`,
    steering files `0644`.
  - **It closes two failures `ln -sfn` could not report.** `ln -sfn` succeeds when its target does
    not exist, and `set -euo pipefail` cannot catch a command that did not fail — so a missing
    development `.env` produced a deploy that reported success and a scheduler that ran with no
    credentials at all, announced by one line in the journal. That is now exit 1 naming the remedy.
    And `ln -sfn` never removed anything: a steering file deleted in the development checkout kept
    its link forever, so production kept translating against a glossary that no longer existed. The
    stale entry is now reported as removed and deleted, links included.
  - **The two trees are asked opposite questions about symlinks, deliberately.** The development side
    *follows* them — a `.env` or glossary that is itself a link is what the scheduler would read, and
    the bash this replaced followed links too, so anything else silently drops a real config file
    from the copy. The deploy side does *not*: a link there is the pre-freeze layout awaiting
    migration, never a snapshot, so it reports as `+`/`~` on the first freeze rather than diffing the
    development file against itself and calling it unchanged — while still being listed, or the
    sweep above could never remove one.
  - **The file list stays derived, never hardcoded.** `git -C <dev> check-ignore` selects exactly what
    the old `link_ignored_config` selected, so a steering file added later is picked up with no edit
    to the script, and the committed `*.example.*` files are never touched in either direction.
  - **The first deploy after rebuilding `~/.herald` will stop, and that is correct.** With no previous
    snapshot every name reports as added and the gate exits 2; `docs/ko/team-runbook.md` now shows the
    two-command sequence for it.

- **`pnpm text:video-backfill [--yes]` — the other half of `x:video-backfill`, for the `[영상]`
  markers already frozen into reviewed text.** `x:video-backfill` fills `videoUrl` on the *collected*
  `x_threads` rows, and that is where it stops: **nothing re-derives stored text on read**, so every
  translation and rendering saved before the mp4 capture existed keeps its url-less `[영상]` no matter
  how completely the collected side has since been filled. Measured against production on 2026-08-08:
  8 translation rows and 4 rendering rows still carried one, every one of them against an item whose
  thread now has its urls. That is not cosmetic — `SendChannels` uploads only
  `videos.filter((url) => url !== "")`, so a rendering with a bare marker goes out without the clip a
  human approved. The fill pairs the Nth marker in a text with the Nth video of the item, and gets
  that order by running the collected thread back through `flattenXThreads` — the very function that
  wrote the markers — rather than walking `thread.tweets[].media`: nested commenter replies and X
  Article bodies produce no markers, so a media walk would shift every pairing after them by one and
  staple the wrong clip onto the post, with nothing downstream able to notice. Where the counts do
  not line up one-to-one, where the thread's own video still has no mp4, or where no collected thread
  stands behind the item at all, **the text is skipped whole and reported with its reason** — a
  half-filled text reads as finished, so a wrong pairing inside one would never be looked at again.
  Writes exactly three columns (`translations.source_text`, `translations.korean_text`,
  `renderings.text`) through the stores that already own those tables, and **never
  `published_text`**, which is the record of what the account actually posted. Previews by default
  like `x:reconcile`/`x:link`/`x:video-backfill`, and the plan splits translations from renderings
  because they are two different decisions: a `posted` translation gaining a url changes only what
  the review screens display, while a `rendered` rendering gaining one changes what the next send
  attaches. Makes no API call at all, so it needs no `TWITTERAPI_IO_KEY`.
- **The dashboard can finally show the scheduler's translation floor — because the scheduler now
  reports it.** `pnpm status` reads that floor by asking systemd (`systemctl --user show
  herald-watch.service`); the hosted dashboard runs as a Vercel function, where there is no systemd
  and no scheduler, so its 수집 hover card could only say the floor cannot be read from here. Honest,
  and useless to the people who mostly use that screen. Copying the value into a Vercel env var was
  rejected outright: a content decision stored twice drifts silently, which is the hazard this whole
  line of work exists to remove. So the unit stays the single source of truth and the watch tick
  *reports* what it actually ran with, into one upserted row (`translate_floor_reports`: `id`,
  `floor`, `reported_at`) that the dashboard reads from the Postgres it already reads everything else
  from. Applied by `pnpm db:migrate`, which `deploy/herald-deploy.sh` already runs on every deploy —
  no separate migration step.
  - **A fourth reach state, `reported`, never folded into `measured`.** `measured` was verified
    against the running manager a moment ago; `reported` is an observation that could be three weeks
    old. The card says `번역 대상 20건 · 하한 아래 114건 (스케줄러 기록)` and prints the report's age
    beside it — `1시간 전` and `21일 전` do not look the same, and past six hours (three missed fires
    of the every-two-hours timer) it says the scheduler may have stopped.
  - **Precedence: a live `systemctl` answer always wins.** It is current by construction; the stored
    report is what a reader with no systemd falls back to. A machine that has both and finds them
    disagreeing shows the gap rather than preferring the fresher number — the gap means either the
    unit was edited and no tick has run since, or the scheduler has stopped, and silently resolving
    it is how the second one goes unnoticed. A unit whose own value is unparseable keeps its
    `unknown`: every tick exits at startup on it, so any report is from a scheduler that is now dead.
  - **The write can never fail a tick.** Same rule `SendChannels` applies after a post has gone out:
    a bookkeeping failure is warned into the journal, not reported as a failure of the work. A
    healthy pipeline does not go red — and page a human via `OnFailure=` — over a one-row upsert.
  - **`floor` is nullable and that matters.** A row with no floor means the tick genuinely ran with
    none (the whole backlog, oldest first — the alarming state); no row at all means nothing has ever
    reported. `pnpm status` gained the same states on its Collected line.

- **A post's video now travels through the pipeline as a playable mp4, and previews in 검수.** The
  `[영상]` marker has been url-less since it was introduced, on the understanding that capturing the
  mp4 was a fast-follow needing a collect-schema change. It needed no new source at all:
  twitterapi.io has been returning the full variant ladder in `extendedEntities.media[].video_info`
  the whole time, and `toMedia` was reading only `media_url_https` — which for a video is the
  **thumbnail**, not the clip. `MediaItem` gains `videoUrl` (highest-bitrate `video/mp4`; the
  `application/x-mpegURL` playlist is never selected, since nothing we deliver to can play it), and
  `XContentSource` writes `[영상] <url>`. The marker stays paren-free — `[영상](url)` is a markdown
  link that `linksToPlain` would rewrite — and `sourceMedia`'s `VIDEO_LINE` already accepted the
  bare-url form, so the send path reads it back with no parser change.
  - **`url` still means the thumbnail.** It is a real asset (a poster frame) and the photo path
    depends on `url` being an image, so the mp4 sits beside it rather than replacing it.
  - **The dashboard previews the clip on hover**, the same shape the photo marker established:
    label as the hover target, `원본 보기 ↗` outside it. Muted and `playsInline` so a pointer
    crossing a marker can never put audio into a shared office, and the `<video>` is not mounted
    until the pointer actually arrives — a 2차 card can carry a dozen markers, and `preload="none"`
    does not help because `autoplay` overrides it the moment the element exists.
  - **A url-less `[영상]` renders exactly as it does today.** Every translation and rendering saved
    before this change keeps the bare marker forever, so it stays plain text rather than becoming a
    preview-less video segment — which also means no caller can hand a `<video>` an empty `src`.
    `MediaEditNotice` now says which of the two the reviewer is actually looking at.
- **`pnpm x:video-backfill [--yes]`** fills `videoUrl` on video media collected before the schema
  change, by tweet id. A re-collect covers most of it (34 of 35 media in production-shaped local
  data), but it cannot reach a thread that has dropped out of X's search listing: the one straggler
  entered the store via `gapFillMissingRoots` and is absent from `advanced_search` **and** from its
  own replies' results, while `GET /twitter/tweets?tweet_ids=` returns it in full. Previews by
  default, patches only `videoUrl`, and matches media by thumbnail url rather than array position.
- **An X send now attaches the post's video.** `SendChannels` has been pulling the mp4 url out of
  the reviewed text and throwing it away with a warning since the marker existed — deferred twice
  because the url was not captured and Typefully's video support was unverified. Both blockers are
  gone: a live probe on 2026-08-08 confirmed `media/upload` takes an `.mp4` file name (201), the
  presigned S3 PUT takes the bytes (200), the status poll reports `ready` with `mime: "video/mp4"`,
  and a draft accepts the resulting `media_id` — at zero cost to the 15/month publishing quota. So
  `TypefullyMedia` is unchanged and there is one uploader, not two; `SendRequest` gains a singular
  `video`, and `TypefullySender` concatenates it onto the photo `media_ids`.
  - **`video` is a `string`, not a `string[]`**, because X's rule is singular: one video per post,
    never beside photos. No sender can build the shape X rejects, so that rule is enforced in one
    place — `SendChannels`, before any upload.
  - **A rendering carrying photos + a video, or two playable videos, is refused rather than
    trimmed.** Both are shapes X rejects, and neither has ever been collected (production
    `x_threads` on 2026-08-08: 90 photo-only tweets, 35 video-only, 0 mixed, 0 with two videos).
    Dropping the video would put a live post in the room missing content a human approved, and the
    `sent` ledger row that follows can never be unmarked; refusing costs one retry, because a
    failed send is not ledgered. Same reasoning as the existing over-limit fail-fast.
  - **A url-less `[영상]` is unchanged: not an upload, not an error.** Those markers are in the
    store forever. The warning that explains them now names the remedy (`pnpm x:video-backfill`)
    instead of claiming X cannot attach video, and says "Telegram video delivery is not
    implemented" on the channel where that is still the true reason.

- **The conversion tick now formats what it converted, so its output actually reaches the 2차 검수
  board.** The tick shipped one stage short of its own purpose: it produced rows in `variants`, but
  the board is built from `renderings` (`src/adapters/web/board.ts` derives its `unconverted` list
  from rendering keys), so an item the scheduler had just converted still read *"이 항목은 아직
  렌더링이 없습니다. `pnpm format` 을 먼저 실행하세요"* and gave the reviewer no button. Measured in
  production on 2026-08-08: the scheduler converted `x:2085728188546855340` into 6 variants at
  13:10–13:12 KST and `renderings` for that day stayed at 0 until `pnpm format` was run by hand.
  - **`pnpm format --only-missing`, and the flag is the whole safety property.** A bare `pnpm format`
    rebuilds *every* rendering it selects from its variant, at `status: "rendered"`, `refined: false`
    — which discards the text a reviewer edited on the board and revokes their approval. That is the
    right behaviour for the dashboard's red `[포맷 다시]` and for a hand run, where a human confirms
    the loss first (`docs/ko/review.md`), and it stays the default. On a 30-minute timer it would
    have erased 2차 검수's accumulated work 48 times a day, silently, starting with the 5 approved
    renderings production is holding right now. The new mode formats only (item, type, channel) pairs
    with **no rendering at all**, built on `FormattingStore.listRenderedKeys()` — which already
    existed, unused anywhere in `src/`, as the exact analogue of the `listConvertedKeys` skip
    `PrepareConversions` uses. The key both sides compare now comes from one exported
    `renderingKey()` in the port: a consumer that rebuilt that string inline would keep compiling and
    match nothing the day a store changed it, and "matches nothing" in this mode does not mean "skip
    nothing", it means overwrite every approved rendering there is.
  - **The skip is per (item, type, channel), not per variant.** One `announcement` fans out to
    telegram *and* kakao; skipping the whole variant because telegram was already rendered would
    leave the 카카오 card permanently missing.
  - **No agent turn, and it runs on every tick — including one that prepared nothing.** Formatting is
    mechanical (canonical text per channel, minus bold where a channel cannot render it), so the
    stage costs a subprocess and a query rather than a `claude -p` turn — which is the only thing the
    "nothing was prepared" early return exists to protect. Gating it on this tick's own conversions
    would strand any variant that lost its rendering for reasons this tick had no part in (an earlier
    tick that failed after `convert:save`, a hand-run `convert:save`, a migration), the same shape as
    the quiet-source-account bug that left 19 translatable items stranded in `WatchTick` for 21 hours.
  - **Unrecognised stage stdout fails the tick, never "nothing to do"** — the contract every parser in
    `WatchTick`/`ConvertTick` already follows, and the zero-work line is a deliberate second shape
    (`formatted 0 rendering(s) — nothing is waiting to be formatted`) rather than a count of zero on
    the `→ the database (renderings)` line. Both shapes and the flag itself live in the new
    `src/cli/formatLines.ts`, the sibling of `convertPrepareLines.ts`: the CLI and the tick are two
    processes that agree on nothing but this text.
  - **`FormatVariants`' warnings (over-length emissions) travel out as `TickReport.notes`**, which
    `tickOutcome` prints ahead of the outcome line — `runStage` captures a stage's stdout and a
    successful tick discards it, so a scheduled `pnpm format`'s ⚠ lines would otherwise be seen by
    nobody. They are notes and not a failure: an over-limit rendering is a copy problem for 2차 검수
    to fix on the board, where the per-destination length is shown anyway, and failing the tick would
    fire the Telegram hook because a Korean tweet came out two weighted characters long. Before the
    outcome line, never after, so that line stays the last journal entry
    `deploy/herald-notify-failure.sh` reads back.
  - **Still nothing that publishes or sends.** The tick's end state moves from `converted` to
    `rendered`, which is not a step closer to an audience: `SendChannels` sends only `approved`
    renderings, and approving one is the human act this tick exists to prepare for. The agent's deny
    list is untouched, and `tests/deploy/convertTiming.test.ts` still fails if this unit's
    `ExecStart=` ever grows a `format` of its own — now for a sharper reason, since a chained one
    would be the unflagged, overwriting kind.
  - The dashboard's three "run `pnpm format`" hints and the runbook's own step 8 now say
    `--only-missing`, because a reviewer following that advice on a board the scheduler keeps filling
    was being told to wipe their own approvals.

- **A scheduled conversion tick (`pnpm convert:tick`, `deploy/herald-convert.{service,timer}`), so
  the 2차 검수 board is already populated when a reviewer gets there.** The pipeline was automated up
  to `translated` and stopped: after a 1차 검수 approval, turning that approval into channel variants
  (`convert:prepare` → an agent pass → `convert:save`) was manual, so in practice the work went out
  by hand and the pipeline was bypassed. The new unit fires **every 30 minutes, 24 hours a day**, at
  `:07` and `:37`.
  - **The agent turn is gated on there being work, and verified afterwards** — the `WatchTick`
    contract, stage for stage. `src/app/ConvertTick.ts` runs `convert:prepare --limit N`, parses its
    stdout, and spawns `claude -p` only when the count is above zero; it then compares `pnpm status`'
    `Converted (variants)` total before and after the pass and **fails the tick** when fewer variants
    landed than were handed over. A clean `claude -p` (exit 0, `is_error: false`, no
    `permission_denials`) proves the process ran and was never blocked — it does not prove the model
    ever called `convert:save`, and reading it as success is a scheduler that is green forever while
    the board never fills. Unrecognised stage stdout fails the tick too, never "nothing to do".
  - **It stops at `converted`, enforced in three places rather than documented in one.** The tick
    runs no format/publish/send stage; `ClaudeCodeAgent` gives the conversion pass exactly one shell
    command (`pnpm convert:save --id * --type * --file *`) and now **denies** `pnpm send:*`,
    `pnpm lark:send` and `pnpm drive:publish` outright for every worksheet kind; and
    `tests/deploy/convertTiming.test.ts` fails if the unit's `ExecStart=` ever grows one. Whether a
    variant is ever sent is what 2차 검수 decides.
  - **Why 30 minutes and not faster.** The database is Neon `free_v3` — 100 CU-hours a month at
    0.25 CU is 400 wall-clock hours — and Neon autosuspends after about five minutes idle, so a
    30-minute poll keeps the compute awake roughly 17% of the time (≈30 CU-hours, 30% of the budget).
    A 10-minute poll is ~91% of it and a 5-minute poll does not fit. The period is asserted at 1800s
    so halving it has to be a deliberate billing decision. Not folded into `herald-watch.timer`
    either: two hours is far too slow for work a reviewer is waiting on. 24 hours a day rather than a
    business-hours window because measured human activity spans 10:00–04:00 KST.
  - **`HERALD_CONVERT_BATCH` defaults to 1**, where `HERALD_WATCH_BATCH` is 3, because the two count
    different things: one approved *item* fans out to up to six types and all of them are written by
    the **same single** `claude -p` call under a 10-minute cap. Throughput is not the constraint —
    one item every 30 minutes is 48 a day against a translate side whose ceiling is 36.
  - **`convert:prepare` no longer writes a worksheet for an empty batch.** It wrote one
    unconditionally, which was harmless at the rate a human runs the command and is not harmless at
    48 fires a day into a directory nothing prunes — and, worse than the litter, its `archiveFile`
    call *moves* `output/variants/pending.json` out of the way before replacing it with `[]`
    (`archive.ts` renames, it does not copy), so a batch someone was midway through saving would be
    relocated into `output/archive/` by the next fire and every remaining `convert:save` would refuse
    with "run convert:prepare first". An empty batch now writes nothing at all and prints
    `prepared 0 variant(s) — nothing approved is waiting to be converted`; the dashboard's
    `[변환 준비]` button (`PrepareConversionRun`) already behaved this way. Nothing parsed that
    stdout before the tick did, and both sides now build the line from
    `src/cli/convertPrepareLines.ts` so a rewording cannot silently break the scheduler.
  - **Approved-only selection was not re-implemented.** `PrepareConversions` already filters
    `status === "approved"`, which is the gate that keeps an unreviewed translation from being
    converted; a second copy of that rule in the tick would be a second place for it to drift.

- **Both scheduled units now leave a durable run log under `~/.herald/logs/`, because the journal on
  this box is a roughly eight-minute window rather than a record.** journald rotates on every
  backwards clock step and this machine's WSL2 host sync and `systemd-timesyncd` both step the clock
  constantly: 365MB of journal on disk was measured holding under ten minutes of history, and a
  **successful** `herald-watch` run at 02:17 had zero recoverable lines by 03:30 the same morning.
  `deploy/herald-notify-failure.sh` already worked around this for the failure path by capturing a
  five-line excerpt the instant a unit fails; a run that succeeded and did the wrong thing, or any
  post-hoc investigation, had nothing at all. `deploy/herald-run-logged.sh` now wraps each unit's
  command (`ExecStart=… herald-run-logged.sh %n …/pnpm watch`), tees its output to
  `~/.herald/logs/<unit>/<UTC timestamp>.log`, and keeps the newest 60 runs per unit — five days of
  watch at its two-hour cadence, fifteen of reconcile at its six-hour one. Each run is framed by
  `=== <unit> started … — <command> ===` / `=== <unit> exited <status> at … ===`, so a past run's
  result and the exact command line it ran (whether `--yes` was passed, for instance) are readable
  from the file alone.
  - **The journal still receives everything.** `StandardOutput=append:` was the obvious one-line
    alternative and was measured before being rejected: a scratch unit using it logged **zero**
    application lines to `journalctl --user -u <unit>` while an identical control unit logged
    normally — it replaces the journal rather than adding to it, which would have traded a working
    failure alert for a log file. (Also measured, for the record: systemd opens an `append:` file
    once per `Exec*` line, not once per unit, so an `ExecStartPre=` rotation works but orphans its
    own output into the previous run's file.)
  - **The command's exit status reaches systemd unchanged**, which is the whole risk of the design:
    both units set `OnFailure=herald-notify-failure@%n.service`, and a wrapper that swallowed a
    non-zero exit would not lose a log line, it would switch off the Telegram alert for a dead
    scheduler permanently and invisibly. A bare `cmd | tee log` reports *tee's* status. Proven end
    to end against real systemd — a scratch unit whose command exits 7 produces `ExecMainStatus=7`,
    `Result=exit-code`, and a fired `OnFailure=` — and held by `tests/deploy/runLogging.test.ts`,
    which runs the real script against commands exiting 0, 1, 7 and 42.
  - **`herald-notify-failure.sh` falls back to the run log when the journal excerpt comes back
    empty**, and then points the reader at the file instead of at a `journalctl` invocation already
    known to return nothing. This is the actual payoff: "captured immediately" buys nothing when the
    journal rotated *before* the hook ran, and a run that failed at minute nine of a thirty-minute
    `TimeoutStartSec=` has already outlived its own journal. Its "never fatal, always exit 0"
    contract is unchanged, including on the new path. The newest run is chosen by **name**, not
    mtime — mtime ordering is exactly what a constantly stepping clock makes untrustworthy.
- **`pnpm lineage --activity [--since <date>]` — a date × stage rollup of the append-only lineage,
  because "when did what happen" had no command and the question kept being put to `pnpm status`
  instead.** `status` counts `status` columns, which say where a record stands *now*; a record that
  has moved on carries no trace of ever having been anywhere else. That cost a wrong conclusion: a
  hand-rolled `select status, count(*) from translations` returned `approved 0` and was read as "1차
  검수 has stalled for ten days", when `x:reconcile` had simply retired 21 items to `posted` (18 of
  them with a null `approved_at`, published by hand and matched later) and the day before had carried
  22 events. `lineage` is the only append-only table in the schema, so it is the only place the past
  still exists — and this command reads it and nothing else.
  - **Rolled up in Asia/Seoul, not UTC.** A UTC rollup is wrong in both directions, not merely
    shifted: 08:00 KST files under the *previous* UTC date, so a Korean working day begins on the day
    before it; and 22:00 KST with 01:00 the next morning share a UTC date, so an evening and the
    small hours after it merge into one. `--since` floors on the same Seoul date the buckets use —
    normalising it to an instant the way `HERALD_TRANSLATE_SINCE` does would make `--since
    2026-08-07` mean 09:00 KST and silently drop that morning's review while still claiming to cover
    the day.
  - **Every row is labelled `machine`, `human` or `either`, and the split is not by stage.** Read off
    every caller of `LineageStore.append` and every construction site of the five use-cases behind
    them: `converted` is machine-only (`convert:save`; no dashboard route builds `SaveConversion`);
    both `approved` shapes and every `forked` shape are human-only (`ApproveRendering` and
    `SaveOutletOverride` exist only in `createDeps`, and the scheduler's agent is denied
    `Bash(*--approve*)` outright); and an unapproved `translated` or `rendered` is written
    byte-identically by the agent's `translate:save`/`format:save` **and** by a reviewer's dashboard
    edit, so those count as `either` rather than being guessed. Presenting `translated` — which the
    watch scheduler's own two-hourly ticks dominate — beside the rest as one "activity" number would
    mislead in the opposite direction from the bug above. All three labels always print with their
    counts, so a `human 0` cannot be misread as "not measured" the way `approved 0` was.
  - `pnpm status` now closes with a pointer here, saying why its counts are not a history.
  - Existing `pnpm lineage` readings are untouched: no args still lists items, `--id <id>` and a bare
    positional still print one item's journey. `--since` without `--activity`, and `--activity` with
    an item id, are both refused rather than silently ignored.

- **`게시됨으로` — the other half of 되돌리기, which until now was a one-way door.** 되돌리기 disputes a
  reconcile match and moves an item off `posted`; nothing could move it back. Not by oversight, but as
  the sum of two rules that each exist for a good reason: `postedUrl` survives the dispute so the next
  unattended `x:reconcile` tick cannot re-retire what a human just corrected (`ReconcileXPublished` —
  a row with `postedUrl` set is "never scored — read, not re-matched"), and `RetireTranslation` reports
  `already-retired` *without writing the status* for the same reason. Both protect a human's
  correction from a machine; together they also made a mis-click permanent. `POST
  /api/translations/:id/retire` restores `posted` from the `postedUrl`/`postedAt` still on the row,
  and the button sits in the note that already tells the reviewer this item was once matched to a
  live post. **Gated on `postedUrl`, which is what stops it inventing history** — 게시됨 is restorable
  only for an item carrying the evidence it went out; a draft that was never posted has nothing to be
  restored to, and the route answers 409. An edit made after the dispute is kept rather than refused:
  `publishedText` still holds the copy that actually went out and 1차 검수 diffs the two, so the
  divergence is displayed instead of being silently asserted away. No history-tab write, unlike
  `RetireTranslation`'s second half — the row already exists from the original retire, and if that
  write had failed, reconcile's conjunctive skip still re-admits the item and repairs it.

- **`pnpm x:reconcile` — reads @0xMantleKR's live timeline back and reconciles it against our own
  approved copy, because the account is the record and the board is not.** Three routes lead to a
  published post — the full pipeline, a partial run finished by hand, and copy written entirely
  outside the system — and only the first leaves a database trace. Measured 2026-08-06:
  @0xMantleKR published 47 times since 2026-07-20 while this pipeline had produced three `x`
  renderings ever, none of which appears among those 47. The command assembles each live thread and
  scores it against every `status: "approved"`, `channel: "x"` rendering, landing one of three
  verdicts: **confirmed** (similarity ≥ 0.95, a copy-paste) writes a `sent` delivery row on the
  `x-post` outlet, so the board reads 발송됨 whether a bot or a human posted it; **candidate**
  (0.50–0.95, or ambiguous provenance) is reported only and writes nothing, because a `sent` row is
  never reversed and a wrong guess there is unrecoverable — a human decides, tagged with why it's a
  candidate (`possible-match`, `duplicate-live-thread`, or `ambiguous-rendering-type`, each pointing
  at a different next action); **external** (below 0.50) writes a publish-history row keyed
  `kr:<rootId>`, which is also what gives `impressions:record` X rows to measure that it couldn't
  see before. Carries its own thresholds (`CONFIRMED_AT`/`CANDIDATE_AT` in
  `src/domain/publish/xReconcile.ts`) rather than reusing `MATCH_THRESHOLD` (0.3): the one real
  measurement available — an unrelated post scoring 0.350 against one of our renderings — is a false
  positive at that floor, so this feature sits its own bands well above it instead. A confirmed
  match is written through `RecordObservedDelivery`, not `MarkDelivery`: `status: "sent"` is already
  defined as an observation, never a human's revocable claim (`src/domain/delivery/models.ts`), so
  `MarkDelivery`'s refusal to let a human tick 전달함 on an auto outlet is unchanged — this is a
  different door, not a bypass of that one. Previews by default; `--yes` is required to write
  anything, and nothing here ever calls Typefully, touches the collect watermark, or writes
  `x_threads`. See `src/app/ReconcileXPublished.ts`, `src/domain/publish/xReconcile.ts`, and
  `src/cli/x-reconcile.ts`.
- **`deploy/herald-x-reconcile.service` + `.timer` — a second systemd --user unit, running
  `pnpm x:reconcile --yes` every six hours at :41.** Slower than `herald-watch.timer`'s two-hour
  cadence on purpose (reconciling a post is not racing to translate one) and off its own :17 by
  design, so their *scheduled* fires never share a minute. That is all the minute buys: both units
  carry `Persistent=true`, so a boot that missed both windows runs both catch-up fires at once, and
  nothing prevents that — the two write disjoint rows and the worst case is contention over `pnpm`,
  twitterapi.io quota, and CPU. This is the
  second scheduled unit `herald-notify-failure.sh`'s own header had been waiting for, so its
  `OnFailure=` hook is now templated (`herald-notify-failure@.service`, taking the failing unit's
  name via `%i`/`%n`) instead of the single hardcoded `herald-watch.service` it used to name
  unconditionally — both units now point at `OnFailure=herald-notify-failure@%n.service`, so a
  reconcile failure names and tails its own journal instead of `herald-watch.service`'s. Not
  installed by anything committed: `~/.config/systemd/user/` still carries the old, non-templated
  pair until a human runs the install/removal steps by hand
  ([`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §6).
- **`pnpm x:reconcile` now also asks each translation that never became an approved rendering "did
  this go out by hand?", because that turned out to be the common shape, not the rare one.** Against
  production on 2026-08-07, five of nine translations already scored under this account had in fact
  been posted directly — copy-paste of an approved rendering (what the confirmed/candidate/external
  bands above already caught) was not what happened here at all. A hand-post is a **rewrite, not a
  paste**: the five true matches scored 0.308/0.365/0.379/0.423/0.484 against their live post, the
  highest of the four unrelated pairs scored only 0.092 — a 0.216 separation, comfortably clear of
  `CONFIRMED_AT`'s 0.95, which is calibrated for a copy-paste this account doesn't produce and so
  caught none of the five. The new `TRANSLATION_MATCH_AT` (0.25) sits deliberately off-centre toward
  the positives (0.058 below the lowest true positive, not centred at ~0.20) because the two errors
  are not symmetric: missing a match leaves the item exactly where it already was, in 검수 대기, at
  zero cost; a false match silently retires something a human still needed to see, and nothing
  surfaces it again on its own. A match retires the translation to a new terminal status **`posted`**
  (게시됨) — `postedUrl`/`postedAt` stamped, then a publish-history row keyed `x:<itemId>` (status
  write first, history row second, so a failed history write is always retried on the next run
  without re-scoring or reattributing the match). A `posted` translation cannot be approved, and
  therefore cannot be converted, formatted, or sent — the lock that stops already-published copy
  going out a second time through the pipeline. 되돌리기 in the dashboard disputes a match: back to
  검수 대기, but `postedUrl` is deliberately left on the row, which is what stops the next unattended
  `x:reconcile` tick from re-retiring the same item. The timer retires automatically under `--yes`;
  a run that retires three or more in one pass sends a Telegram notice via `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_CHAT_ID_OPS` (`notifyOps`, the same pair `deploy/herald-notify-failure.sh` uses), because
  that is a success worth a human's attention, not a failure the `OnFailure=` hook would ever see.
  X-only by design, matching this feature's own scope: candidates are drawn from `source: "x"`
  translations and live threads on the one account this whole feature reads. See
  `src/domain/publish/xReconcile.ts` (`TRANSLATION_MATCH_AT`, `bestThreadFor`), `src/app/
  ReconcileXPublished.ts` (Phase B), and `src/app/RetireTranslation.ts`.
- **`pnpm db:migrate` — the schema-apply step, for the first time separated from `serve`/`db:import`/
  `db:export`.** Every earlier schema change added a whole new table, so a database nobody had
  migrated always failed loudly on the first read (`relation ... does not exist`) from whichever of
  those three commands touched it first. This branch's `translations.posted_url`/`posted_at` are
  columns added to a table that already existed on every prior install, and columns don't announce
  themselves the same way: `pnpm x:reconcile` run against the real production database failed with
  `column "posted_url" does not exist` before this command existed to fix it. `db:migrate` runs
  `applySchema` on its own, safe to re-run any time (every statement is `create table if not exists`
  / `alter table ... add column if not exists`), with no `--yes` gate — unlike `db:import`/
  `db:export`, it can only ever add schema that was always going to be there. `pnpm doctor`'s schema
  check is now column-aware for the same reason: it used to probe one table's existence and call that
  "applied", which is exactly the check that reported healthy against a database still missing the
  two new columns. See `src/cli/db-migrate.ts`, `src/adapters/db/schema.ts` (`isSchemaApplied`,
  `ALTERED_COLUMNS`), and `src/doctor/checks.ts`.

### Changed

- **The dashboard header stopped drawing a funnel over a pipeline that branches.** It read
  `수집 134 → 번역 23 → 변환 10 → 렌더 13 → 발행 16`, and every arrow claimed something the data does
  not support. Past 번역 a row stops being an item — a variant is keyed `(itemId, type)`, a rendering
  `(itemId, type, channel)`, a publish-ledger row `(itemId, status, target)` — so the line appeared to
  *gain* work between 변환 and 렌더 when **three items** had simply fanned out twice (10 and 13 rows
  over the same 3 items). And 발행 is not downstream of 렌더 at all: it counts the translation
  markdown uploaded to Drive, a sibling branch off 번역, and 3 of its 9 items have no rendering.
  Each stage now shows its item count, plus its row count as `N건` where the two differ, separated by
  `·` instead of `→`. `pnpm status` gained the same item counts. Both are now built by one function,
  `funnelCounts` in `src/status/pipeline.ts`, alongside the CLI's own `pipelineStages` — they were
  separate code, and it showed: the CLI learned about the terminal `posted` status while the header
  kept counting it as work in progress.
- **The `GET /api/status` funnel is now pinned by `tests/web/typeMirror.test.ts`.** Changing it from
  five numbers to five `{ items, rows }` tallies left **both typechecks green** while the dashboard
  kept its own `number` declaration — it would have rendered `[object Object]` in the header on the
  first deploy. The mirror test file existed for exactly this class of drift but was not pointed at
  this payload.

- **`pnpm status` and the 1차 검수 tabs now say how many items are actually waiting, instead of
  letting a finished queue look like a full one.** Once `x:reconcile` began retiring hand-published
  translations to the terminal status `posted`, the funnel's `Translated 23 (approved 0)` read as
  "23 waiting, none approved" when the truth was 21 done and **2** waiting — the same misreading the
  sync line's own comment had already warned about for its half of the report. The translated stage
  now names all three buckets, actionable first (`pending 2 · approved 0 · posted 21`); the other
  stages keep the bare `approved N`, having no terminal third status to hide behind it. The sidebar
  tabs carry the matching per-filter counts, derived from the same predicate that decides which rows
  a tab shows, so a tab can never promise a row it then does not display. Tab labels shortened to the
  `StatusChip` vocabulary one row below them (대기 · 승인 · 게시됨): four tabs plus counts do not fit a
  `w-80` sidebar at the old widths — `검수 대기 5` wrapped its count onto a second line — and a tab
  should not name a status differently from the chip it filters for. A rendering underneath a
  `posted` translation is deliberately **not** discounted anywhere: the X post having gone out by
  hand says nothing about whether its 공지 is still owed to Telegram and Kakao.

- **Replies Mantle made to other accounts no longer enter the pipeline at all.** Measured against
  production on 2026-08-07: **92 of 221 collected threads (42%) were reply-only** — "@elfa_ai 🥳🥳",
  "@Agnidex 💚", "@ethereum Onwards." — each arriving in 1차 검수 as its own row for a human to skip.
  A further 140 nested reply blocks sat inside 46 real threads, prefixed `(댓글 · 지워도 됨)`, which
  was an instruction to delete them by hand on every worksheet, forever. Both are now filtered at the
  source (`XContentSource.flattenXThreads`): a reply-rooted thread never becomes a `ContentItem`, and
  a nested reply never reaches the 원문. The predicate is unchanged and deliberately narrow — a reply
  is `isReply` **and** its text leads with an `@`. Each half rules out a case the other would destroy:
  a self-thread continuation is `isReply` without a leading `@`, and a genuine post can open with a
  mention without being a reply. The exclusion is total, matching how `collect:reference` already
  isolates @0xMantleKR's own posts: a filtered reply cannot be recovered by `translate:prepare --ids`,
  because it never becomes an item for the selector to find.

### Fixed

- **`pnpm status` states the translation floor, and qualifies the Collected total with it.** That
  total counts every collected item back to the first collect, but the watch scheduler runs
  `translate:prepare --since $HERALD_TRANSLATE_SINCE` — so on 2026-08-08 a Collected total was read
  as a backlog and reported to a human as one, when the floor put most of it permanently out of the
  scheduler's reach. The floor's only real home is `Environment=` on `herald-watch.service`: `.env`
  carries the key blank and nothing else in the repo carries the value, so there was no read-only
  way to ask what production selects with. The stage line now reads
  `Collected (X + Lark)  135   (224 X threads - 92 replies dropped + 3 Lark · in scope 20 · below floor 115)`,
  with the floor itself printed under the table.
  - **The whole funnel is on that one line, left to right.** Qualifying the total with the floor
    alone left the same class of question — "is 135 even right?" — answerable only by a database
    query, because ~41% of everything ever collected is a reply Mantle made to someone else and is
    dropped before it can become an item (`isCommenterReply`). The counting reuses that predicate
    rather than restating it, over `status = 'active'` threads and their first tweet, so the number
    printed is the drop the pipeline actually took.
  - **The Lark term is named, and derived.** `224 - 92 = 132`, but the headline is 135: three Lark
    items are in the total and are not threads, and a reader who subtracts and comes up 3 short
    concludes the pipeline lost items. The remainder is computed as `total - (threads - dropped)`,
    never counted separately, so the printed arithmetic reaches the headline by construction — and
    on the one input where it cannot (a `collect` landing between the two reads), no funnel is
    printed at all rather than one that visibly fails to add up. Zero terms are omitted, and a
    deployment with no X threads reads exactly as it did before.
  - **Asked of systemd, not of the shell.** `systemctl --user show herald-watch.service` reports
    what the *manager* loaded, so a unit file edited without `daemon-reload` is described by what
    will really run rather than by what someone meant. `process.env.HERALD_TRANSLATE_SINCE` is
    empty in a hand-run and arbitrary in a shell that exported it; when it disagrees with the unit
    it gets its own ⚠ line saying so, and it is never used as the answer.
  - **Five states, because "no floor" and "no answer" are opposite facts.** `systemctl show` exits 0
    for a unit it has never heard of and prints a bare `Environment=` for it — identical to a loaded
    unit that sets nothing — so `LoadState` is read alongside. A loaded unit with no floor is the
    alarming one (⚠ the whole backlog is in scope, oldest first); a missing unit is just a dev
    machine. A `systemctl` that is absent, non-zero, slow, or unrecognisable degrades to
    "cannot determine" and never throws: this is a read-only diagnostic, and it also runs as a stage
    inside every watch tick.
  - **The floor and the scope are required arguments** of `pipelineStages`/`formatStatus`, not
    optional ones. The bare total is the shape that caused the misreading, so the table cannot be
    rendered without saying how much of it is in reach.

- **The dashboard sends no referrer, without which every video preview 403s.** `video.twimg.com`
  enforces a Referer allowlist: the same mp4 that returns 200 with no Referer returns 403 with the
  dashboard's own origin, and a `<video>` that gets a 403 fails with `MEDIA_ERR_SRC_NOT_SUPPORTED`.
  `pbs.twimg.com` does not enforce it, which is why photo previews have always worked and why
  nothing connected the two. The policy has to be document-level — `referrerpolicy` is defined for
  img/iframe/link/script/a but not for media elements, so it cannot be scoped to the one element
  that needs it. A test pins the meta tag, because deleting it turns nothing else red.

- **A format run no longer builds channel cards for an item that has already been published.**
  `selectVariants` filters on `types`/`ids`/`channels` and never looked at the source translation's
  status, so `pnpm format --only-missing` — added this morning and run by the scheduler every 30
  minutes — read a retired item's absent renderings as work to do and manufactured them. Three items
  were in that state in production on 2026-08-08 (`x:2080608995371597892`,
  `x:2080661810034917770`, `x:2081711456320655644`: 13 renderings, 10 variants between them), and
  they sat on the 2차 검수 board as finished work a reviewer could not clear. Deleting the renderings
  by hand did not help either — the variants remain, so the next tick rebuilt every one, losing the
  approvals and keeping the clutter.
  - **The rule is `PublishTranslations`', extended, not a new one.** That class already refuses to
    re-process a `posted` translation, for every caller, because a finished item's record is the
    record of what went out and re-processing *demotes* it. What re-processing demotes here is the
    2차 검수 board rather than the Drive doc; the reasoning is the same and its comment is not
    repeated in `FormatVariants`.
  - **The skip applies to every caller, not only to `--only-missing`.** Scoping it to the scheduled
    mode was the alternative and it is the weaker one: a bare `pnpm format` is documented as
    "rebuild every card" and is what an operator runs after re-saving a conversion, so under that
    scoping it would resurrect every card a human cleanup had just deleted — the cleanup would not
    have survived one hand run. `posted` already means terminal for every caller in four other
    places (`PublishTranslations`, `syncSummary`, `loadPublishState`, the 발행 route); a fifth that
    meant it only on a timer is where a rule like this drifts. The cost is that `[포맷 다시]` and
    `pnpm format --ids <a posted item>` render nothing; 되돌리기 reopens the item and 게시됨으로
    closes it again, exactly as the Drive path already documents.
  - **The refusal is reported rather than returned as a silent zero.** `FormatVariants.run` now
    reports `skippedPosted`, `pnpm format` prints `skipped n item(s) already posted` under its
    summary line, and the format route answers `alreadyPosted: true` alongside `rendered: 0`. An
    unexplained zero is indistinguishable from "your selector matched nothing", which is the
    appears-to-work-and-does-nothing shape this CLI already refuses elsewhere (`--only-missing` with
    `--refine` throws rather than being ignored). The new line is deliberately not a `⚠`: it is the
    permanent steady state of every retired item, not something `ConvertTick` should carry into the
    journal as a note, and the summary line the tick parses is unchanged.
  - **Counted where a write was actually declined**, which is why the gate sits after the
    already-rendered check rather than before it: a finished item whose cards are all still on the
    board is not work this run refused, and reporting it would put a line in the scheduler's run log
    every 30 minutes about nothing having happened.
  - **`status === "posted"` and nothing else.** Not `postedUrl`, which 되돌리기 leaves on the row as
    the evidence of a disputed match — a gate on it would refuse exactly the item a reviewer just
    reopened. An item with no translation row at all still formats: only an explicit `posted` says
    "this went out", and the send path already blocks a missing source loudly.
  - **The rest of what the schedulers touch was checked, not assumed.** `PrepareConversions`
    (`convert:prepare`) filters `status === "approved"`; `PrepareTranslations` (`translate:prepare`)
    selects only ids with no translation row at all, via `listTranslatedIds`, which counts every
    status; `PrepareAlignment` (`translate:align`) filters `status === "translated"`; `collect` and
    `status` write no translation; `RetireTranslation` (`x:reconcile`) is idempotent on `postedUrl`,
    so a 되돌리기 survives the next reconcile. `FormatVariants` was the only hole.

## [0.4.0] - 2026-08-06

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

- **`api/[...path].ts` + `vercel.json` — a Vercel Function entry point for the review dashboard,
  alongside the existing `pnpm serve`.** A thin adapter over the same `handleApi`/`refusalReason`
  that `HttpServer.ts` already uses: it turns a Vercel Function's Web-standard `Request` into the
  `(method, path, body)` those already expect and turns the answer back into a `Response`, adding no
  routing or use-case logic of its own. One `pg.Pool` per function instance (`@vercel/functions`'
  `attachDatabasePool`), never one per request. The session gate runs, and the CSRF origin check
  refuses a foreign origin, before THIS FUNCTION reads the request body — Vercel's own platform
  already accepts up to 4.5 MB at the edge and delivers it with the invocation regardless (there is
  no local-server equivalent of refusing the accept itself), so this ordering bounds the function's
  own work and still enforces the existing 2 MiB cap for an authenticated caller, but it is not a
  guarantee about what the platform already buffered for an unauthenticated one — see
  `api/[...path].ts`'s own comment for the precise boundary. The CSRF allowlist is
  `HERALD_DEPLOYMENT_ORIGIN`, a required environment variable rather than a hardcoded loopback check —
  the default `*.vercel.app` domain means this deployment's own origin does not exist until it is
  deployed, so guessing or defaulting permissively was not an option. The function also refuses to
  start unless `HERALD_TRUST_PROXY=true`: a Vercel Function has no raw socket, so without it the
  per-address login lockout has no address to key on and only the global 50-failure backstop is left.
  `vercel.json` builds `web/dist` as static output and disables all Git-triggered deployments
  (`git.deploymentEnabled: false`) so no preview deployment — another public URL with a login page on
  it — is ever created automatically; the first (and every) deploy is `vercel deploy --prod` run by
  hand. No `crons` key: Vercel Hobby caps cron at once a day, so `pnpm send:reconcile` stays a local
  command. See `refusalReason` (now parameterized on which origins count as "this deployment",
  `HttpServer.ts`), `resolveClientIp` (now typed over a minimal structural request shape,
  `clientIp.ts`, since a Vercel `Request` has no raw socket the way `node:http`'s does), and
  `currentSession` (now exported from `HttpServer.ts` and reused here, over the same structural-type
  move, rather than a second cookie-reading path).
- **The hosted deployment's send routes ship closed, behind `HERALD_SENDS_ENABLED`.** The team gets
  1차/2차 approval working on the first deploy; `POST /api/outlets/:id/:type/:outletId/send` — the
  only route that can reach a live Telegram room or the brand's X account — refuses until this flag
  is explicitly turned on, with a Korean reason and the rebuilt board rather than a bare failure.
  `POST /api/items/:id/reconcile` is unaffected: it only reads Typefully and writes urls onto rows
  that already exist. The flag is a separate axis from local-vs-hosted (`createDeps.ts`'s
  `routes: "local" | "hosted"`): `pnpm serve` always sends, exactly as it always has; only the hosted
  route set is ever closed. Mechanically this reuses the same "route set is a property of the entry
  point" pattern `prepareConversionRun`/`convert-prepare` already established — `ApiDeps.sendToOutlet`
  is now optional, and its absence is checked before anything else in the route, not hidden behind a
  disabled button. `StatusView.sendsEnabled` reports the same boolean for the dashboard's own banner
  (below) — and for `OutletCard`'s per-row [발송]/[재발송], which now paint the same locked
  (`발송 · 잠김`) treatment an ineligible row already gets, with the identical Korean reason the route
  itself answers with. Enforcement is the route either way; the button lock exists so an operator is
  never invited to confirm an irreversible post through a dialog that cannot actually happen.
- **A persistent, non-dismissible dashboard banner when the attached database is not `production`,
  and another when sends are closed.** `EnvironmentBanner` (`web/src/components/`) reads
  `StatusView.dbEnv`/`sendsEnabled` and renders above the header — never hidden by scrolling, no
  close button — Korean, matching the board's existing register. Renders nothing when a field is
  absent (an older cached response) rather than guessing.
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
- **Pin a Telegram send, from `pnpm send:channels --pin` or the dashboard's 핀으로 고정하기 checkbox
  on a Telegram room's 발송/재발송 confirm.** Both default off. `TelegramBotSender` pins the message
  that carries the post's text — the photo, when the whole text went out as its caption — one message
  per send, silently (`disable_notification: true`), and never removes a room's existing pin. Pinning
  needs the bot to be an **administrator** of the room: `can_pin_messages` in a group/supergroup, or
  `can_edit_messages` in a channel. A missing right does not block the send — the post still goes
  out, and the run reports "글은 올라갔지만 고정하지 못했습니다 — 봇을 이 방의 관리자로 올리고, 그룹은
  '메시지 고정', 채널은 '메시지 수정' 권한을 주세요 (…)" as a warning, which the dashboard shows as
  an error banner while the row settles to 발송됨. See `TelegramBotSender.send`
  (`src/adapters/send/TelegramBotSender.ts`), `SendChannelsInput.pin`/`SendChannelsResult.warnings`
  (`src/app/SendChannels.ts`), and `OutletCard`'s `pinOffered` (`web/src/components/OutletCard.tsx`).
- **`pnpm watch` — an unattended scheduler, one tick at a time.** Chains `collect` → (only if
  `collect` found anything new) `translate:prepare --limit 3 --since <cutoff>` → an unattended
  `claude -p` fill of the translation worksheet → `translate:align --limit 3` → (only if there is a
  precedent to align against) a second `claude -p` fill, then exits. A tick that finds nothing new spends one
  twitterapi.io call and never touches the agent. Stops dead at `status: "translated"` —
  `translate:save` is never called with `--approve` on this path, and nothing downstream
  (`convert:*`, `send:*`, `drive:publish`) is ever invoked, so a scheduled run can only ever hand the
  board something to review, never publish it. Both `claude -p` calls run with `--output-format json`
  and a narrow `--allowedTools` list, never `--dangerously-skip-permissions` — the one process here
  that is unattended and reaches the production database is the one place that flag is least
  defensible. Before any stage runs, `watch.ts` also prints one line naming which output root and
  which database this tick is attached to (`watchStartupLine`, `src/cli/watchStartup.ts`) — the
  wrong-tree-or-database mistake that cost 39 threads once now shows up in every single tick's
  `journalctl --user -u herald-watch`, not only when someone happens to run `pnpm doctor` first.
  A clean `claude -p` is not accepted as proof that anything was saved: exit 0, `is_error: false`
  and an empty `permission_denials` are equally true of a model that read the worksheet, decided it
  was done and stopped, so the tick brackets the translation pass with `pnpm status` and **fails**
  unless the `Translated` total grew by the whole prepared batch. Without that, an agent that never
  called `translate:save` produced a green tick over an unsaved batch that nothing downstream would
  ever notice — `collect` gates the next tick on *new* threads, so those items are not retried
  until unrelated content arrives, and the next `translate:prepare` archives them on its way past.
  Failure details are collapsed to one line and truncated (`src/shared/text/condense.ts`) so the
  `OnFailure=` hook's 500-character journal excerpt still contains the `watch: FAILED — <stage>:`
  prefix rather than the tail of someone's stack trace. **The scheduler's output is reviewed on the
  deployed board, not on `pnpm serve`** — it writes to production Neon while `pnpm serve` reads
  `.env`'s local `DATABASE_URL`, so a local dashboard will never show a scheduled tick's work
  ([`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §6 says so explicitly).
  See `src/cli/watch.ts`, `src/app/WatchTick.ts` (the sequencing decisions — collect 0 → the agent
  is never invoked; align "nothing to align" → the second agent call is skipped; any unrecognised
  stage output is treated as a failure, never as success), `src/adapters/agent/ClaudeCodeAgent.ts`,
  and `docs/superpowers/specs/2026-08-05-watch-scheduler-design.md`.
- **`deploy/` — the systemd user units that run `pnpm watch` on a schedule, plus its Telegram failure
  hook. Not installed by anything committed** — see [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md)
  §6 for the copy-and-enable steps, which stay manual on purpose: the paths are machine-specific
  absolute paths found on the one machine this runs on, and the timer only ever reads
  `~/.herald/prod.env`, which a human creates by hand (a production DSN does not pass through an
  agent session). `herald-watch.timer` fires every two hours, off the hour
  (`OnCalendar=*-*-* 0/2:17:00`, verified with `systemd-analyze calendar`), deliberately conservative
  while this is new. `herald-watch.service` runs one tick as `Type=oneshot` — systemd's own mutual
  exclusion is the concurrency guard here, not a lock file or an advisory lock — with an explicit
  `PATH` (a systemd user unit has none of `pnpm`/`node`/`claude` on it by default), a
  `TimeoutStartSec=1800` outer bound so a wedged run cannot leave the unit "active" through the next
  scheduled fire, and `OnFailure=herald-notify-failure.service`. **Four files, but only three get
  installed:** `OnFailure=` can only name a unit, never a bare script (`man systemd.unit`), so
  `herald-notify-failure.service` is a thin wrapper unit around `herald-notify-failure.sh`, which
  sends one Telegram message naming the failed unit, a short tail of that unit's own journal
  captured at the moment the hook fires (`journalctl --output=cat`, capped at 500 characters, kept
  even when the unit's log is otherwise gone by the time a human reads the alert — journald on the
  target machine rotates on every backwards clock step, and the readable window has been measured
  at roughly eight minutes), and the `journalctl` command to read more, then exits `0`
  unconditionally — a failure handler that can itself fail is a loop, not a safety net. The excerpt
  is JSON-escaped before it reaches the hand-built request body, since it is the failed unit's own
  output rather than a fixed string and can itself contain quotes, backslashes or newlines. Skipping
  the wrapper *unit* leaves `OnFailure=` pointing at a unit that doesn't exist, and the failure notice
  silently never fires — exactly the failure class this whole feature exists to prevent. The `.sh`
  itself is **not** copied alongside the three units: the wrapper's own `ExecStart=` names its path
  inside the repo directly, so a copy would never run and would only drift from the original the
  first time either is edited — it just has to stay executable where it already lives.
  `.vercelignore` gained an anchored `/deploy/` entry: unanchored, `deploy/` would also match, and
  drop, `src/deploy/` from the Vercel Function bundle — the same mistake `translation/`'s own entry
  already exists to guard against.
- **`HERALD_TRANSLATE_SINCE` — the floor that keeps the scheduler current instead of merely busy.**
  `translate:prepare` takes the first `--limit` items of the *whole* untranslated set, oldest first,
  so `--limit 3` alone is a cap without a floor: the first production tick collected 23 new threads
  and then translated three from 2026-07-14, because 211 untranslated items reaching back to
  2026-06-01 stood in front of them — roughly six days of ticks before the scheduler would have
  reached what it had just collected. `pnpm watch` now passes this through to
  `translate:prepare --since`. It is configuration rather than a constant because it is a content
  decision — which historical posts are being chosen, deliberately, never to translate — and the
  team's rule sets it at the last already-translated post. Unparseable values are refused at
  startup instead of reaching `--since` as garbage, where they would quietly translate nothing for
  as long as nobody read a journal; unset keeps the whole-backlog behaviour a hand-run gets.
  It must name the same instant as the collect watermark seeded into
  `~/.herald/output/x/state.json`, or the gap between the two floors becomes content that is
  fetched and then never translated, with no failing unit and nothing in a journal to read —
  `tests/deploy/watchCutoff.test.ts` holds the unit file and the runbook to the same value.
- **The scheduler's artifacts live under their own root, `~/.herald/output` (`HERALD_OUTPUT_DIR`),
  never the repo's own `output/`.** `collect`'s watermark (`output/x/state.json`) stayed file-backed
  when everything else moved to Postgres (`src/cli/stores.ts`), so it is shared by every run
  **regardless of which database that run targets**. During this feature's own implementation, a
  dev-database `pnpm collect` run advanced that one file 39 threads past what a production run had
  actually seen; a later production run would have skipped all 39 permanently. `HERALD_OUTPUT_DIR`,
  set by the systemd unit's own `Environment=`, is resolved to an absolute path (`src/paths.ts`) so a
  relative override cannot silently land under whatever directory the process happened to start in,
  the way a relative `OUTPUT_DIR` once did. `pnpm doctor`'s new "Output root" check always names
  whichever root is actually in effect — `(default)` or `(HERALD_OUTPUT_DIR override)` with the
  resolved path — so a non-default root is never a silent one. A second new doctor check, "Telegram
  ops chat (watch failures)", warns when `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID_OPS` aren't both set,
  since the failure hook otherwise runs and exits `0` without telling anyone. See
  `src/doctor/checks.ts`'s `outputRootResult`/`telegramOpsChatResult`.
- **`HERALD_WATCH_BATCH` — one dial for both translate stages' `--limit`, replacing the two
  hardcoded `3`s a tick used to run with.** Sets the item count `pnpm watch` hands to both
  `translate:prepare --limit` and `translate:align --limit` in the same tick; unset keeps the
  batch size of 3 every command already used (`DEFAULT_WATCH_BATCH`, `src/cli/watchBatch.ts`).
  Throughput is `batch * 24 / 2` items/day at the two-hour cadence the scheduler ships with — the
  number that decides whether translation keeps pace with collection or quietly falls behind it —
  and that ratio is tuned by watching the backlog, not by reading the code, on a different clock
  than a deploy runs on; only `pnpm watch`'s own systemd unit is meant to set it, never a
  developer's local `.env`. `parseWatchBatch` validates it in `src/cli/watch.ts` before the
  startup line prints and before any stage runs, so a typo'd value refuses the tick at the entry
  point — naming the variable and the exact value rejected — instead of reaching
  `translate:prepare --limit`/`translate:align --limit` as garbage (a fraction, a sign, a
  `Number()`-coercible string like `"0x10"`, or a digit run too long to survive `Number()`). A
  *blank* value is not one of the rejections: an `HERALD_WATCH_BATCH=` line with nothing after it
  reaches Node as `""` and is read as unset, yielding 3 — which is the point, since `Number("")` is
  0 and `--limit 0` is what a naive read would have handed every tick. The variable is documented
  for the operator in [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §6, not only in
  `.env.example`, and `herald-watch.service` carries a commented `Environment=` placeholder beside
  the two lines it does set. Raising it does **not** require raising `herald-watch.service`'s
  `TimeoutStartSec=`: `ClaudeCodeAgent` spawns `claude -p` once per worksheet regardless of how many
  items that worksheet holds, so one tick still makes at most two agent calls (translation, then
  alignment) at any batch size, and the 30-minute timeout's arithmetic is unchanged. What *does*
  bound a sane batch is the timeout inside each of those calls — `ClaudeCodeAgent`'s
  `DEFAULT_TIMEOUT_MS` caps one `claude -p` at 10 minutes, and a 30-item worksheet spends longer in
  that single call than a 3-item one — so the unit comment, `.env.example` and the runbook all now
  name that ceiling and say to raise the batch in steps rather than in one jump.
- **`HERALD_COLLECT_MAX_PAGES` — a one-run override for the collector's page cap, default
  unchanged at 50 (`DEFAULT_MAX_PAGES`, `src/adapters/twitterapi/TwitterApiSourceGateway.ts`).**
  Exists for exactly one situation: recovering from a coverage GAP (see `Fixed` below) by hand,
  with the cap raised for that one backfill run. Read at the CLI, by `parseCollectMaxPages`
  (`src/cli/collectMaxPages.ts`), and passed to the gateway as a constructor option — so only
  `pnpm collect` and `pnpm collect:reference` honour it, and the four other commands that build the
  same gateway (`tm:measure`, `metrics:record`, `impressions:record`, `reconcile`) always get the
  default even with the variable exported. `collect:reference` is included because it runs the same
  `CollectAuthoredContent`, so exhausting the cap there also advances a watermark past an un-fetched
  tail, and because `pnpm tm:measure` exists to say whether that account's history fits inside the
  cap — an estimate with no dial to act on if the cap were unreachable from there. **`pnpm watch`
  refuses to start while the variable is set** (`refuseCollectMaxPagesOverride`, called from
  `src/cli/watch.ts` in the same position as `parseWatchBatch`): a tick spawns each stage as
  `pnpm <script>`, so a stray value left in the repo's `.env` after a backfill would truncate every
  scheduled collect, GAP-fail every tick and lose the older tail each time — and "the scheduler's
  unit never sets this" was previously a claim in three documents and a check in none. A blank
  value is still fine, because `.env.example` ships the line blank and installs copy that file.
  Validated by the same `parsePositiveIntEnv` rule `HERALD_WATCH_BATCH` uses (blank → default,
  otherwise a bare positive *safe* integer or a named, actionable throw), pulled out to
  `src/shared/env/positiveInt.ts` once a second `HERALD_*` variable needed the identical rule
  rather than a second reimplementation of it.
- **`tests/deploy/watchTiming.test.ts` checks `herald-watch.timer`'s fire period against
  `herald-watch.service`'s `TimeoutStartSec=` instead of leaving that constraint as a comment.**
  systemd skips an `OnCalendar=` fire that comes due while the unit is still active, so a timeout
  longer than half the fire period can turn one wedged tick into a scheduler that looks armed and
  has silently stopped — the exact failure this whole feature exists to prevent. The test derives
  the period from `OnCalendar=`'s two shapes this timer plausibly uses (`*-*-* 0/N:17:00` and
  `*-*-* *:17:00`) and refuses to guess a period for any other shape rather than silently skipping
  the bound. It also asserts the timer states its schedule exactly once and only as an
  `OnCalendar=`: systemd accumulates multiple `OnCalendar=` lines and `OnUnitActiveSec=` sets a
  period a third way, either of which would shorten the real fire period while a check that reads
  only the first line kept passing. `herald-watch.timer`'s own header calls out "hourly is a
  one-line change" — exactly the edit someone would make without re-deriving the timeout arithmetic
  first, and now the one that trips this check if the two files drift apart.
- **The watch scheduler's startup line now names a tick's inputs, not only its output root and
  database.** `watchStartupLine` (`src/cli/watchStartup.ts`) appends the batch size
  (`HERALD_WATCH_BATCH`) and the translation floor (`HERALD_TRANSLATE_SINCE`) — the two values an
  operator can change without a deploy — so `journalctl --user -u herald-watch` answers "what was
  this tick configured to do", not only "what did it do". An unset translation floor prints as
  `(none)` rather than being dropped from the line: "no cutoff" and "cutoff configured" are the two
  most consequential ticks there are, and a line that silently omits the floor when unset would be
  indistinguishable from one that simply forgot to print it.

### Changed

- **Dashboard session lifetime cut from 12 hours to 2 hours.** Signing out
  (`POST /api/logout`) only ever cleared the cookie in the browser — the session token itself was
  never revoked, so a stolen-then-logged-out token stayed usable until it expired regardless. Rather
  than build a server-side revocation record, `SESSION_TTL_MS` (`src/domain/auth/session.ts`) now
  bounds that exposure window at 2 hours instead of 12. The cookie's `Max-Age` is derived from the
  same `SessionConfig.ttlMs` a caller passes to `verifySession`, so the two cannot drift; a test now
  pins that derivation to the constant rather than a copied literal.
- **The login lockout is now two layers, not one.** A single global counter (5 failures/60s,
  account-wide) meant one stranger sending a wrong guess from anywhere could hold the whole team out
  of the dashboard indefinitely, at zero cost, and — since the lockout now survives a restart —
  restarting the server was no longer a way out. `PgAttemptLimiter` (`src/adapters/store/PgAttemptLimiter.ts`)
  now supports a row per scope: a **per-IP counter** at the original threshold (5 failures/60s,
  self-clearing) stops one address from locking out anyone but itself, and the **global counter**
  stays as a backstop at a much higher threshold (50 failures/60s) so a genuinely distributed attempt
  across many addresses still trips something. A login is refused if either layer says so
  (`src/app/Login.ts`). Both counters now **decay**: a failure count with a gap since the last attempt
  wider than the 60s lockout window is treated as the start of a fresh run rather than added to
  whatever accumulated before the gap, so "N failures/60s" is a real rolling window rather than "N
  failures ever, until a lockout happens to get served" — without decay, a single address could burst
  to its own per-IP threshold, sit out that lockout for free (a refusal the per-IP layer already turns
  away never reaches the counter), and repeat indefinitely, walking the GLOBAL counter up to its own
  threshold over an unbounded stretch of wall-clock time and eventually locking out the whole team from
  one address alone. The client IP a per-IP row keys on is never read from a client-settable header by
  default — `src/adapters/web/clientIp.ts`'s `resolveClientIp` uses the raw socket address unless the
  new, opt-in `HERALD_TRUST_PROXY`/`HERALD_TRUST_PROXY_HOPS` (see `.env.example`) explicitly says this
  server sits behind a specific reverse proxy that appends to `X-Forwarded-For` itself; trusting that
  header by default would let one attacker defeat per-IP limiting entirely by forging a different
  address on every request. A trusted entry is also shape-checked (a coarse IPv4/IPv6 pattern, capped
  at 64 characters) before it becomes a row id, so a misconfigured hop count landing on
  client-controlled chain positions cannot hand an attacker an arbitrary primary key either. When no
  trustworthy IP can be determined, the request falls back to the global counter alone rather than
  being keyed under one shared bogus value — and this fallback is what actually happens for every
  caller **unless `HERALD_TRUST_PROXY` is explicitly set for a deployment that really does sit behind a
  reverse proxy**; without it, every request behind that proxy resolves to the proxy's own fixed
  socket address, and per-IP limiting degrades to one shared bucket for the whole team, not a
  bucket-per-visitor. Per-IP rows are evicted by a sweep that runs from both `recordFailure` and
  `recordSuccess` (any row untouched for over an hour is deleted on the next per-IP write from
  either) — both, not just `recordFailure`, because either can be the write that creates a fresh
  per-IP row in the first place (a first-ever login from a new address that happens to be correct
  creates a row exactly like a wrong one does), so an install where every login succeeds cannot grow
  `auth_attempts` without bound either.
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
- **A coverage GAP is now a tick failure instead of free text in a journal nobody reads.**
  `collect` pages newest-first and stops at a 50-page cap (`MAX_PAGES`); when a run actually hit
  that cap, the watermark still advanced to the newest tweet it *had* fetched, and the older tail
  it never reached was skipped — permanently, since the next tick's floor is already past it. The
  tick reported success regardless, because `collect`'s GAP notice (boundary timestamps and all)
  was appended to its one line of stdout as free text `WatchTick` never parsed. A hole opened, no
  alert fired, and the only trace was a line in a journal nobody reads on a healthy day. `WatchTick`
  now parses that tail, and a GAP fails the tick before any downstream stage runs — `translate:*`
  never sees the hole — so the `OnFailure=` hook's Telegram alert fires, carrying the GAP's own
  boundary timestamps, a pointer to the backfill procedure, and the warning that **the following
  tick goes green regardless of whether the hole was filled**, because the watermark had already
  moved before the alert ever fired — a green tick after a GAP alert is not evidence the loss was
  recovered. The alert deliberately does **not** inline a command, because a working backfill takes
  two corrections at once and either alone recovers nothing: the page cap has to be raised for that
  one run (`gap.from` is the exact floor the failing run already used, and the collector always
  pages down from the newest tweet, so a bare `--since` re-run re-fetches the same newest tweets and
  truncates at the same place), *and* the run has to be pointed at the scheduler's own database and
  output root. `pnpm collect` is `tsx --env-file-if-exists=.env`, so a hand run from the checkout
  writes to the repo's local Docker database and appends a clean `gap: null` row to the repo's own
  `output/x/runs.json` — a recovery that never touched production, with a confirming artifact to
  match. The full procedure, including sourcing `~/.herald/prod.env` and setting `HERALD_OUTPUT_DIR`
  for that one command and verifying from `~/.herald/output/x/runs.json`, is in
  [`docs/ko/team-runbook.md`](docs/ko/team-runbook.md) §4's GAP section. The failure detail's wording
  was measured against `watchOutcome`'s real 300-character Telegram budget (`condense`, which
  truncates from the tail) rather than guessed — 261 of 300 at the GAP text's longest — specifically
  so the "a green tick is not proof" clause is never the part a truncation cuts.
- **`docs/ko/team-runbook.md` and `docs/ko/artifacts.md` no longer recommend scheduling `pnpm
  collect --since 2h` hourly** (`artifacts.md` had marked it "권장"). Both predate the watch
  scheduler and would have actively broken it if followed: `--since` puts a collect run into adhoc
  mode, which never advances the watermark, so wiring it into the scheduled automation would freeze
  the watermark permanently — and since every tick would then be re-collecting the same rolling
  window rather than only what is genuinely new since the last run, `collect`'s reported thread
  count would essentially never be zero, permanently disabling `WatchTick`'s gate that skips calling
  the agent when there is nothing to do. Both docs now name `pnpm watch` as the actual scheduler,
  describe the sliding-window `--since` pattern as a hand-run backfill tool rather than an
  automation substitute, and `team-runbook.md` documents the GAP alert and its remedy in the same
  section.

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

[Unreleased]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kyle-park-io/mantle-kr-herald/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kyle-park-io/mantle-kr-herald/releases/tag/v0.1.0
