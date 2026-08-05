# Watch scheduler — new posts translated before anyone asks

A systemd timer that walks the pipeline from collection to `translated` on its own, so the 1차
검수 board already has work waiting on it instead of waiting for someone to remember to run
`pnpm collect`.

Written 2026-08-05, after measuring the machine it will run on. Every constraint below comes from
something checked on that machine or read out of this repo, not from a guess about how schedulers
usually work.

## The goal, in one sentence

Every hour, if @Mantle_Official posted something new, have it collected, translated, and aligned by
the time Kyle opens the board — and stop dead at the human gate.

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
  ├ translate:prepare --limit 3
  ├ claude -p  ①                → fill the translation worksheet → translate:save (no --approve)
  ├ align --limit 3             → "aligned 0"? skip ②
  └ claude -p  ②                → fill the alignment worksheet → translate:save
```

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

`OnFailure=` fires a one-line Telegram message: what failed, and the `journalctl` command to read
it. `TELEGRAM_BOT_TOKEN` already exists; only a chat id is new.

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

## Files

| | |
| --- | --- |
| `src/cli/watch.ts` | the tick: stage sequencing, early exits, exit codes |
| `src/app/WatchTick.ts` | the use-case — decides which stages run, given each stage's result |
| `src/adapters/agent/ClaudeCodeAgent.ts` | spawns `claude -p`, parses `--output-format json` |
| `src/ports/WorksheetAgent.ts` | the port `WatchTick` depends on, so tests substitute a stub |
| `package.json` | the `watch` script |
| `deploy/herald-watch.service` | `Type=oneshot`, `OnFailure=`, explicit `PATH`, `WorkingDirectory` |
| `deploy/herald-watch.timer` | `OnCalendar=*-*-* 0/2:17:00`, `Persistent=true` |
| `deploy/herald-notify-failure.sh` | the `OnFailure=` target — one Telegram line |
| `.vercelignore` | `/deploy/` — anchored, so `src/deploy/` survives |
| `docs/ko/team-runbook.md` | a section: install, inspect, pause, read logs |
| `.env.example` | the new Telegram chat id, in the right section with a comment |

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

`ClaudeCodeAgent` gets its own narrower tests for parsing `--output-format json` — including a
malformed payload, since a scheduler that reads a crashed agent's output as success is exactly the
silent failure the Telegram hook exists to prevent.
