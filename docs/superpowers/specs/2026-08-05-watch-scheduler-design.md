# Watch scheduler — new posts translated before anyone asks

A systemd timer that walks the pipeline from collection to `translated` on its own, so the 1차
검수 board already has work waiting on it instead of waiting for someone to remember to run
`pnpm collect`.

Written 2026-08-05, after measuring the machine it will run on. Every constraint below comes from
something checked on that machine or read out of this repo, not from a guess about how schedulers
usually work.

## The goal, in one sentence

Every two hours, if @Mantle_Official posted something new, have it collected, translated, and
aligned by the time Kyle opens the board — and stop dead at the human gate.

## Where it stops

`status: "translated"`. Nothing downstream moves.

- No `--approve`, ever. The agent drafts; a human approves.
- No `send:channels`, no `drive:publish`, no conversion, no channel formatting.
- No `tm:promote` — it promotes only pairs a human already marked accepted
  (`acceptedRecords` in `src/cli/tm-promote.ts`), so it has no business running unattended.

This is the same gate `translate:align`'s own plan states: *"a saved alignment stays
`status: "translated"` (never auto-approved)"*.

## One tick

```
pnpm watch                      ← one command, run by the systemd unit
  ├ collect                     → 0 new? stop here. No agent call.
  ├ translate:prepare --limit 3 --since <cutoff>
  │                             → prepared 0? skip ①
  ├ status                      → the Translated total, before
  ├ claude -p  ①                → fill the translation worksheet → translate:save (no --approve)
  ├ status                      → grew by the whole batch? no → fail the tick
  ├ align --limit 3             → "aligned 0"? skip ②
  └ claude -p  ②                → fill the alignment worksheet → translate:save
```

**Every stage's stdout is parsed, and unrecognised stdout is a failure — never "nothing to do".**
A stage that exits 0 having printed something this doesn't recognise has told us nothing about
what it did, and reading that as the quiet early-exit is how a broken collector becomes a
scheduler that succeeds forever while doing nothing.

**A clean `claude -p` is not proof that anything was saved.** Exit 0, `is_error: false` and an
empty `permission_denials` prove the process ran and was never blocked; a model that reads the
worksheet, decides it is done and stops produces exactly that envelope. So the tick brackets the
translation pass with `pnpm status` and requires the `Translated` total to have grown by the whole
prepared batch. Not a second `translate:prepare` with a "did the count drop?" rule, which was the
obvious version and is wrong: `PrepareTranslations` selects the first `--limit` of *every*
untranslated item, so with a backlog bigger than the limit — the same "burst of ten posts drains
over several ticks" this design describes below — that count reads 3 before and 3 after a perfect
pass. `status` is read-only and moves by exactly one per saved item, because `prepare` only ever
hands over items that have no translation row at all.

**A TypeScript CLI, not a shell script.** This repo has zero shell scripts and no `scripts/`
directory; it has forty-odd `src/cli/*.ts` entrypoints and a vitest suite. Writing this one stage in
bash would mean building a shell-stubbing harness from nothing just to assert the decisions below,
while the same assertions are ordinary unit tests under `tests/cli/`. The systemd unit invokes
`pnpm watch`.

**No lock.** `Type=oneshot` will not start a second instance while the first is still running, so
systemd is the mutual exclusion for the scheduled path — a `flock` would have been carrying
crontab's weight, not systemd's. A Postgres advisory lock was considered and rejected: `createDb`
returns a `Pool`, so a session-scoped lock lands on a borrowed connection and a later query may get
a different one. A file lock was rejected for a stronger reason — this repo already paid for that
mechanism's mtime-and-liveness failure modes once.

What stays uncovered is running `pnpm watch` by hand while the timer is armed. The runbook says to
use `systemctl --user start herald-watch.service` instead, which systemd serializes correctly.

**The early exit is the design.** Most ticks find nothing and end after `collect`, spending one
twitterapi.io call and no agent time at all. A scheduler that woke Claude 24 times a day to be told
there is nothing to do would burn the subscription for no reason.

`collect` is already incremental — it stops client-side at the per-handle watermark in
`output/x/state.json` — so a flag-less run is exactly the "anything new?" question this needs, and
it advances the watermark as a side effect. There is nothing to add.

## Why systemd, not crontab

Both are OS-level and both survive the terminal closing; that was never the axis. The axis is what
you get for free:

| | crontab | systemd timer |
|---|---|---|
| Logs | stdout mailed to a local MTA — with none installed, **silently discarded** | `journalctl --user -u herald-watch` |
| Missed runs | never happened | `Persistent=true` catches up once |
| Start with WSL | a separate `@reboot` line | the same unit |
| Failure hook | wire it yourself | `OnFailure=` |
| `PATH` | minimal — `pnpm` and `claude` are not on it | set explicitly |
| Next/last fire | not recorded | `systemctl --user list-timers` |

The `PATH` row is the one that bites first and looks like a broken script when it does.

### Measured on the target machine (2026-08-05)

- `systemd` is PID 1 (`/etc/wsl.conf` has `systemd=true`) — user units are available.
- **`Linger=yes` is already set** for `kyle`. This is the usual WSL2 trap: without lingering, the
  user manager exits when the last terminal closes and takes the timers with it. It is already
  handled, so a **user unit** (`~/.config/systemd/user/`) is safe, and preferable to a system unit —
  it runs as Kyle and therefore sees `~/.claude`'s subscription credential and the repo without any
  extra plumbing.
- `crontab -l` → `no crontab for kyle`. Nothing to collide with.

Schedule: **`OnCalendar=*-*-* 0/2:17:00`** — every two hours, off the hour. Deliberately
conservative while this is new; hourly (`*-*-* *:17:00`) is a one-line change once it has run
unattended for a few days without surprises.

The minute is pinned off `:00` on purpose. Not the `hourly` shorthand either, which expands to
`*:00:00` — every scheduler on the planet fires there and there is no reason to join it.

**The interval is not the test lever.** `systemctl --user start herald-watch.service` runs one tick
immediately, on demand, as many times as you like; the timer only decides when it happens without
you. Verify behaviour that way and let the interval stay boring.

## Talking to the right database

The board is a thin reader over Neon (`src/vercel/entry.ts` opens one `pg` Pool over `DATABASE_URL`
and hands it to `handleApi`). So **content reaches Vercel by being written to production Postgres —
there is no deploy step, and no artifact to copy.** Redeploying is for code and environment
variables only.

`.env` points at local Docker, and `docs/ko/deploy.md` rule 3 says not to touch it. Verified on this
machine that an exported shell variable **wins over Node's `--env-file`**:

```
FOO=from_shell node --env-file-if-exists=t.env -e '…'   →  from_shell
```

So the script sources two lines and lets `.env` supply everything else:

```bash
set -a; . "$HOME/.herald/prod.env"; set +a   # DATABASE_URL, HERALD_DB_ENV
pnpm collect                                 # TWITTERAPI_IO_KEY etc. still come from .env
```

`~/.herald/prod.env` lives outside the repo, holds two lines, and is `chmod 600`. It also sidesteps
the documented trap that `vercel env run -e production` can never return production values from
inside this repo.

**Kyle creates this file.** A production DSN does not pass through an agent session.

### The database is not the only thing that needs separating

Pointing the scheduler at production Neon isolates the *database*. It does not isolate the
**collect watermark**, and that gap is not theoretical — it fired during implementation.

`src/cli/stores.ts` states the rule plainly: the `WatermarkStore` half of `LocalJsonStore`
(`output/x/state.json`) deliberately stayed file-backed when everything else moved to Postgres,
because "`collect` is a local job". So one file answers "how far have I collected?" for **every**
database. A local dev `pnpm collect` advances it; a later production run reads the advanced value
and skips everything in between — permanently, and silently.

That is exactly what happened on 2026-08-05: a run against the dev database pulled 39 threads and
moved the watermark from `2026-07-21T04:24:50.000Z` to `2026-08-04T17:15:30.000Z`. Production would
never have seen those threads. Recovered by reading the pre-run value out of `output/x/runs.json`'s
`requested.since` and restoring it.

**The fix is a separate output root for the scheduler**, chosen deliberately rather than as a
patch: this project is not yet fully in production, and the priority is an environment where
experimenting locally cannot disturb the scheduled run, or vice versa. `src/paths.ts` derives every
path from a single `OUTPUT_DIR` constant, so an `HERALD_OUTPUT_DIR` override is one line and the
whole tree follows — including `ClaudeCodeAgent`'s permission rules, which Task 3 already derives
from `paths.translationsWorksheets` rather than a literal.

**The override must be loud.** `REPO_ROOT`'s own comment records why `OUTPUT_DIR` was fixed in the
first place: a relative path once "silently created a second `output/` tree instead of failing". An
invisible override recreates that bug wearing a different hat. So: resolve the value to an absolute
path, have `pnpm doctor` report which root is in effect, and have any command running against a
non-default root say so on startup. A wrong tree must never be a quiet outcome.

### The consequence worth stating

`output/` drifts further from the database, because the scheduler writes rows the local file tree
never sees. That is already true and already documented; the scheduler makes it true faster.
`pnpm db:export` remains the way to re-mirror.

Note the scheduler's own tree is now a third thing: its worksheets and `pending.json` live under
its root, not in the repo. That is intended — it is the isolation — but it means a worksheet the
scheduler prepared is not where a hand-run `pnpm translate:prepare` would have put it.

## Running `claude -p` unattended

`claude --help` confirms `-p, --print` — "Print response and exit". It spawns a fresh process,
authenticates from the credential on disk, and exits. **No interactive session is involved**, which
is the entire reason this works when nobody is watching.

- Permissions come from a narrow `--allowedTools` list. There is no human to answer a prompt.
- **`--dangerously-skip-permissions` is not used.** This process is attached to the production
  database and runs with nobody watching; those are the two conditions under which that flag is
  least defensible.
- `--output-format json` so the script can tell "saved N" from "did nothing" rather than guessing
  from an exit code.

Two calls per tick, not one. Each has a single job, and the second is skipped outright when there is
nothing to align — one combined call would have to be told to conditionally do half of itself.

## Alignment is a no-op today, on purpose

`translation/tm.json` currently holds **one** precedent pair, and `translate:align` excludes any
draft with zero shared-anchor precedents. So today it will almost always print
`nothing to align · skipped N (no precedent)` and exit before writing a worksheet — meaning no agent
call, no cost.

It is in the loop anyway. The TM grows from Kyle's own approvals, so the step wires itself up over
time; adding it later would mean revisiting the script for no benefit now.

## Knowing when it breaks

`OnFailure=` fires a one-line Telegram message: what failed, a short excerpt of that unit's own
journal captured the moment the hook runs (`journalctl -n 5 --output=cat`, capped at 500
characters), and the `journalctl` command to read the rest. The excerpt is not a nicety —
journald on this machine rotates on every backwards clock step, and the readable window has been
measured at roughly eight minutes, so a message carrying only the pointer can easily point at
nothing by the time anyone reads it. `TELEGRAM_BOT_TOKEN` already exists; only a chat id
(`TELEGRAM_CHAT_ID_OPS`) is new.

That 500-character budget is also why nothing upstream may hand this hook an unbounded string: the
tick prints one line, journald splits a multi-line detail across entries, and the hook keeps the
*tail*, so an untruncated stack trace costs the alert the `watch: FAILED — <stage>:` prefix
entirely. `runStage` and `watchOutcome` both collapse whitespace and truncate for that reason.

A scheduler that dies quietly is worse than no scheduler, because the board keeps looking correct —
it just stops growing, and nobody notices for days.

**Non-failures stay silent.** A tick that finds nothing sends nothing.

## What this does not solve

- **The machine has to be on.** This runs on Kyle's desktop against his Claude subscription;
  that is what makes it free. If it ever needs to run regardless of the machine, the translation
  step has to become a `Translator` port with a Claude API adapter, because
  `anthropics/claude-code-action` accepts only `ANTHROPIC_API_KEY` — there is no subscription path
  in GitHub Actions. Estimated at $10–30/month at Sonnet pricing for ~10 items/day.
- **Nothing detects a bad translation.** The gate is Kyle reading the board. This ships more drafts
  to that gate; it does not raise the floor under them.
- **`--limit 3` is a cap, not a queue.** A burst of ten posts drains over several ticks. That is
  deliberate — it keeps a single failed tick cheap and keeps the review queue at a human pace.
- **`--limit 3` alone drains from the wrong end.** `PrepareTranslations.applySelector` takes the
  first `--limit` of the *whole* untranslated set, oldest first, and the first production tick
  (2026-08-06) found 211 untranslated items reaching back to 2026-06-01 — so the 23 threads that
  same tick had just collected would not have been translated for roughly six days. A cap without a
  floor makes a scheduler that is busy and current at the same time impossible. Hence
  `HERALD_TRANSLATE_SINCE`, below.

## Two floors, one decision

The scheduler has two independent lower bounds, and they are not derived from each other:

| Floor | Where it lives | Governs |
|---|---|---|
| collect watermark | `%h/.herald/output/x/state.json` (seeded by hand at install) | how far back `collect` fetches |
| `HERALD_TRANSLATE_SINCE` | `Environment=` on `herald-watch.service` | how far back `translate:prepare` selects |

They must name the same instant. Anything collected below the translate floor is fetched, stored,
and then never translated — with no failing unit and nothing in a journal to read, which is the
failure mode this design is otherwise built to make impossible. `tests/deploy/watchCutoff.test.ts`
is what stops the two from drifting; the runbook's prose about it is not load-bearing on its own.

The value is configuration rather than a constant because it is a content decision — which
historical posts the Korean account is choosing never to translate — and the team's standing rule
sets it at the last already-translated post. On 2026-08-06 that was `x:2081748977918337053`,
created `2026-07-27T14:35:24.000Z`, leaving exactly the 23 threads the first tick collected.

`pnpm watch` refuses to start on a value `Date` cannot parse rather than passing it through: a
typo'd cutoff reaching `--since` as garbage is a scheduler that quietly translates nothing for as
long as nobody reads a journal. Unset means the whole backlog, which is what a hand-run
`pnpm watch` gets.

## Files

The table below is what shipped, not what was sketched: the four entrypoint-and-unit files this
started as grew a handful of small modules, each pulled out for the same reason — a top-level
script has no test coverage of its own, so every decision that matters had to move somewhere a
test could reach it.

| | |
| --- | --- |
| `src/cli/watch.ts` | the entrypoint: prints the startup line, wires the tick, sets the exit code |
| `src/app/WatchTick.ts` | the use-case — decides which stages run, given each stage's result |
| `src/ports/WorksheetAgent.ts` | the port `WatchTick` depends on, so tests substitute a stub |
| `src/adapters/agent/ClaudeCodeAgent.ts` | spawns `claude -p`, parses `--output-format json` |
| `src/adapters/agent/runStage.ts` | the `StageRunner`: `pnpm <script> <args…>`, non-zero → a failure with its stderr |
| `src/adapters/agent/spawnCapture.ts` | the one real `spawn` — argv array (never a shell), fixed cwd, `signal`, stdin closed |
| `src/cli/claudeSpawn.ts` | the real `ClaudeSpawnFn`, named so a test can prove the abort signal is forwarded |
| `src/cli/watchSummary.ts` | `TickReport` → the one line printed and the exit code systemd reads |
| `src/cli/watchStartup.ts` | the line printed before any stage: which output root, which database |
| `src/shared/text/condense.ts` | one-line, length-capped details, so the failure alert keeps its prefix |
| `src/doctor/checks.ts` | `outputRootResult` (a non-default root is never silent) and `telegramOpsChatResult` (the hook can reach Telegram) |
| `src/paths.ts` | `OUTPUT_DIR`'s `HERALD_OUTPUT_DIR` override, resolved to an absolute path |
| `package.json` | the `watch` script |
| `deploy/herald-watch.service` | `Type=oneshot`, `OnFailure=`, explicit `PATH`, `WorkingDirectory`, `TimeoutStartSec=`, `EnvironmentFile=`, `HERALD_OUTPUT_DIR` |
| `deploy/herald-watch.timer` | `OnCalendar=*-*-* 0/2:17:00`, `Persistent=true` |
| `deploy/herald-notify-failure.service` | the wrapper `OnFailure=` actually names |
| `deploy/herald-notify-failure.sh` | what that wrapper runs — one Telegram line |
| `.vercelignore` | `/deploy/` — anchored, so `src/deploy/` survives |
| `docs/ko/team-runbook.md` | §6: install, inspect, pause, read logs, and which board the output lands on |
| `.env.example` | the new Telegram chat id, in the right section with a comment |

**Of the four `deploy/` files, only three get installed.** `OnFailure=` takes a list of **units**;
it cannot name a bare script (`man systemd.unit`, systemd 255), so the hook needs a wrapper unit.
Skip that wrapper and `OnFailure=` points at a unit that does not exist — the failure notice
silently never fires, which is the failure class this design exists to prevent.

The **three units** are copied to `~/.config/systemd/user/`. The `.sh` is **not**: the wrapper's
`ExecStart=` names its path in the repo, systemd ignores a non-unit file in the unit directory
anyway, and a copy would silently diverge from the repo original the first time either is edited.
It only has to stay executable where it is.

`deploy/` is a **new** top-level directory (only `src/deploy/` and `tests/deploy/` exist today).
Because `vercel deploy --prod` uploads the working directory, it needs a `.vercelignore` entry, and
that entry must be anchored: an unanchored `deploy/` matches at every depth and would silently drop
`src/deploy/` from the function — the exact failure `.vercelignore`'s own comment records for
`translation/`. `tests/deploy/vercelignore.test.ts` guards this.

Units are installed by copying to `~/.config/systemd/user/` — not committed there, so the repo stays
the source and the install step is explicit.

The port/adapter split exists for one reason: `WatchTick`'s decisions are the whole risk of this
feature, and they are only cheaply testable if the thing that shells out to `claude` is substitutable.

## Tests

`WatchTick`'s sequencing decisions are the risk, so the tests target those, not the plumbing. Each
runs against a stub `WorksheetAgent` that records its calls, so nothing spawns `claude`:

- `collect` reports 0 new → the agent is never invoked, and the tick reports success.
- `align` reports `aligned 0` → the second agent call is never invoked.
- Any stage failing → non-zero exit, and the failing stage's name appears in the message.
- The `translate:save` invocation **never** contains `--approve`. Worth pinning on its own: it is
  the one invariant whose violation is silent and unrecoverable.
- Unrecognised stdout from `collect`, `translate:prepare`, `translate:align` or `status` → the tick
  fails. One test per stage, because the guards are per stage and each was independently deletable.
- A clean agent pass that saved nothing, or only part of the batch → the tick fails; the same
  wiring with a full save → it succeeds. Both halves, or a check that failed unconditionally would
  satisfy the first one on its own.
- `collect`'s line is still read when pnpm printed `Already up to date` above it. Every stage runs
  as `pnpm <script>`, and pnpm writes those to stdout ahead of the script's own output.

`ClaudeCodeAgent` gets its own narrower tests for parsing `--output-format json` — including a
malformed payload, since a scheduler that reads a crashed agent's output as success is exactly the
silent failure the Telegram hook exists to prevent — and for the argv it builds, which is where
this feature's real containment lives: the `--disallowedTools` deny rule that beats every allow
rule, the single `Bash(pnpm translate:save --id * --file *)` allow rule (pinned by equality, so
both deleting it and widening it to `Bash(*)` fail), and the approval boundary in the prompt.
Every one of those is asserted for **both** worksheet kinds: the alignment pass is a second
`claude -p` call running the same save steps, and therefore an equal path to an approved
translation.
