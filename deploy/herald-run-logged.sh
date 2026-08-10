#!/usr/bin/env bash
# deploy/herald-run-logged.sh
#
# Runs one scheduled command and leaves a durable, human-readable log of it under
# ~/.herald/logs/<unit>/, in addition to — never instead of — the journal.
#
# Why this exists: journald on this box is not a log store, it is a ~8 minute window. journald
# rotates its journal on every backwards clock step, and this machine's WSL2 host sync and
# systemd-timesyncd both step the clock constantly; 365MB of journal on disk was measured holding
# under ten minutes of history, and a *successful* herald-watch run at 02:17 had zero recoverable
# lines by 03:30 the same morning. So `journalctl --user -u herald-watch.service` answers "what did
# last night's run actually do?" with nothing at all. deploy/herald-notify-failure.sh already works
# around this for the failure path, by capturing a five-line excerpt the instant a unit fails (see
# its own comment on the eight-minute window); a run that succeeded and did the wrong thing, or any
# post-hoc investigation, had nothing whatsoever. Fixing the clock needs root and is a separate job.
#
# Usage, from a unit's ExecStart=:
#   ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n /abs/path/to/pnpm watch
# $1 is the calling unit's own name (systemd's %n): it keys the per-unit log directory, and it is
# the same key deploy/herald-notify-failure.sh derives its fallback lookup from, so the two agree
# without either hardcoding a list of units. Everything after $1 is the command, run verbatim.
#
# NOT `StandardOutput=append:%h/.herald/logs/...`, which is the obvious one-line alternative. It was
# measured on this box (systemd 255) before being rejected, and it fails on two counts:
#   - `append:` REPLACES the journal rather than adding to it. A scratch unit with
#     `StandardOutput=append:` logged zero application lines to `journalctl --user -u <unit>` — only
#     systemd's own Starting/Finished — while an otherwise identical control unit logged its line
#     normally. herald-notify-failure.sh reads the journal for its excerpt, so `append:` would have
#     traded a working failure alert for a log file: one sink swapped for another, not both.
#   - systemd opens an `append:` file once per `Exec*` line, not once per unit. Measured with a
#     scratch unit whose ExecStartPre= renamed the file mid-run: the ExecStartPre's own later output
#     followed the renamed inode (its fd was already open), while each subsequent ExecStart= opened
#     a fresh file at the original path. Rotating via ExecStartPre= therefore does not corrupt the
#     current run's log — but it does orphan the rotation step's own output into the previous run's
#     file, which is a wart this script does not have to carry.
#
# EXIT STATUS IS THE COMMAND'S, ALWAYS. This is the one property here that must never regress. Both
# callers set `OnFailure=herald-notify-failure@%n.service`, so a wrapper that swallows a non-zero
# exit does not lose a log line — it switches off the Telegram alert for a dead scheduler,
# permanently and invisibly, because the symptom of a broken failure alert is silence and silence is
# also what success looks like. A bare `cmd | tee log` reports TEE's status, which is 0 whenever the
# file is writable (i.e. always), so the status is read out of `${PIPESTATUS[0]}` below with nothing
# allowed between the pipeline and that read. tests/deploy/runLogging.test.ts runs this script for
# real against commands exiting 0, 1, 7 and 42 and asserts each code arrives at the caller intact.
#
# Deliberately NOT `set -e`, for the same reason deploy/herald-notify-failure.sh is not: every
# logging step below must degrade to "run without a durable log" rather than abort, and the script
# must reach its explicit `exit "$STATUS"` carrying the command's own code. The two argument checks
# immediately below are the exception — see their comment.
set -uo pipefail

UNIT="${1:-}"
if [ -z "$UNIT" ]; then
  # Refuse rather than guess, exactly as herald-notify-failure.sh does with the same argument. A
  # missing %n is a wiring mistake in the caller's ExecStart=, not one of the runtime conditions
  # this script absorbs quietly, and for these callers a failed unit is also what fires the Telegram
  # alert — so the mistake is loud on the first fire instead of producing runs logged to a directory
  # named after nothing.
  echo "herald-run-logged.sh: refusing to run — no unit name given as \$1 (systemd's %n)" >&2
  exit 64   # EX_USAGE, so a wiring mistake is distinguishable from the wrapped command's own codes
fi
shift

if [ "$#" -eq 0 ]; then
  echo "herald-run-logged.sh: refusing to run — no command given after the unit name '$UNIT'" >&2
  exit 64
fi

# The durable log root — the same tier as %h/.herald/app and %h/.herald/output, and inside neither
# checkout: a log written under the deploy checkout is wiped by herald-deploy.sh's `git reset
# --hard`, and one written under the development tree turns up in someone else's `git status`.
#
# `${HOME:-}` rather than `$HOME` because this script runs under `set -u`: an unset HOME must
# degrade to "no durable log" via the writability check below, not kill the wrapper before the
# scheduled command ever runs. HERALD_LOG_DIR exists so tests/deploy/runLogging.test.ts can run this
# same script for real against a temp directory; nothing in production sets it.
#
# deploy/herald-notify-failure.sh resolves the same root with the same expression, to find its
# fallback excerpt. tests/deploy/runLogging.test.ts pins the two spellings equal — two files, one
# decision, the same coupling tests/deploy/workingDirectory.test.ts pins between the units'
# WorkingDirectory= and herald-deploy.sh's APP_DIR.
LOG_ROOT="${HERALD_LOG_DIR:-${HOME:-}/.herald/logs}"

# One directory per unit, keyed on the unit's own name with the `.service` suffix dropped, so
# herald-watch's history is never interleaved with herald-x-reconcile's — they fire on different
# cadences into the same blind spot, and "what did last night's reconcile do?" should be a read, not
# a grep. herald-notify-failure.sh derives the same directory from the same `${UNIT%.service}`.
UNIT_LOG_DIR="$LOG_ROOT/${UNIT%.service}"

# How many past runs to keep, per unit. Enforced here rather than left to logrotate: nothing on this
# box runs logrotate over a user's own dotfiles, and an unbounded log directory on a machine whose
# entire problem is that nobody looks at it is a disk that fills silently.
#
# Sixty is five days of herald-watch at its two-hour cadence (12/day) and fifteen days of
# herald-x-reconcile at its six-hour one (4/day) — enough that a failure noticed on Monday still has
# the weekend's runs behind it. A retained-run count, not a byte budget: a byte cap answers "how
# much disk" but not "can I still see the run I am asking about", and the second question is the one
# this file exists for. What bounds a single run's size is the units' own TimeoutStartSec= (1800s
# for watch, 600s for reconcile), which is what stops one wedged run from being the whole budget.
DEFAULT_KEEP_RUNS=60
KEEP_RUNS="${HERALD_LOG_KEEP_RUNS:-$DEFAULT_KEEP_RUNS}"
if ! [[ "$KEEP_RUNS" =~ ^[1-9][0-9]*$ ]]; then
  # A garbage override must not silently mean "keep everything" — that is how a cap becomes a
  # suggestion, and the consequence surfaces as a full disk months later rather than as this line.
  echo "herald-run-logged.sh: HERALD_LOG_KEEP_RUNS='$KEEP_RUNS' is not a positive integer — using $DEFAULT_KEEP_RUNS" >&2
  KEEP_RUNS="$DEFAULT_KEEP_RUNS"
fi

# UTC, second resolution. These names are what orders the directory: they are read back in sorted
# order — by bash's own glob expansion here, and by `ls -1` in herald-notify-failure.sh — and never
# by mtime, because mtime ordering is precisely what this box's constantly stepping clock makes
# untrustworthy, and it is the same clock that destroys the journal this file exists to replace. The
# steps measured here are ±23s against runs two hours apart, so a backwards step cannot reorder two
# runs; `tee -a` below (never `>`) means even a same-second collision appends rather than clobbers.
RUN_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Keep at most KEEP_RUNS-1 of the existing runs, so this run's own file makes KEEP_RUNS.
#
# Pruning happens BEFORE this run's file is opened, for two reasons. It means the file being written
# right now is never a pruning candidate, at any cap, including a cap of one. And pruning afterwards
# would never happen at all in the case that matters most: a run killed by its unit's
# TimeoutStartSec= does not reach "afterwards", and a wedged scheduler is exactly when the directory
# keeps growing.
prune_old_runs() {
  local keep=$1 old=() excess
  # Bash expands a glob in sorted order already, and these names are ASCII digits plus `T`/`Z`, so
  # no locale collates them differently — no `sort` needed, and no `ls` output to parse. `nullglob`
  # so a first-ever run sees an empty list rather than the literal pattern as a filename.
  shopt -s nullglob
  old=("$UNIT_LOG_DIR"/*.log)
  shopt -u nullglob
  excess=$(( ${#old[@]} - keep ))
  if [ "$excess" -gt 0 ]; then
    rm -f -- "${old[@]:0:excess}"
  fi
}

# Everything from here to the pipeline degrades to "run without a durable log" rather than failing
# the unit. A logging wrapper that can break the thing it is logging is worse than no wrapper: the
# scheduled work is the point, the log is instrumentation.
LOG_FILE=""
if mkdir -p "$UNIT_LOG_DIR" 2>/dev/null; then
  prune_old_runs "$(( KEEP_RUNS - 1 ))"
  if : >> "$UNIT_LOG_DIR/$RUN_STAMP.log" 2>/dev/null; then
    LOG_FILE="$UNIT_LOG_DIR/$RUN_STAMP.log"
  fi
fi
if [ -z "$LOG_FILE" ]; then
  # Goes to stderr, so it lands in the journal (and, for a failing run, in the Telegram excerpt) —
  # "the logs you went looking for do not exist" is itself worth saying out loud.
  echo "herald-run-logged.sh: cannot write under $UNIT_LOG_DIR — running $UNIT without a durable run log" >&2
fi

# Header and footer are written to both sinks by hand rather than folded into the pipeline below,
# because anything else in that pipeline costs the exit status: the left-hand side of a pipeline
# runs in a subshell, so `{ header; "$@"; footer; } | tee` cannot hand the command's own status back
# out, and `${PIPESTATUS[0]}` would then be the whole block's rather than the command's.
#
# The two sinks are kept byte-identical on purpose. herald-notify-failure.sh reads the journal first
# and this file second, and an alert whose content depended on which source happened to answer would
# be harder to read, not easier.
say() {
  printf '%s\n' "$1"
  [ -n "$LOG_FILE" ] && printf '%s\n' "$1" >> "$LOG_FILE"
  return 0   # the `[ -n ]` test above is the last command; without this, an empty LOG_FILE returns 1
}

# NOTE for whoever changes what goes around the command: deploy/herald-notify-failure.sh sends the
# last LOG_TAIL_LINES lines of this file, so every line printed after the command's own output costs
# one line of the alert's context. The footer below is deliberately the only one. A command that
# needs something guaranteed into the alert should not rely on that budget at all — it marks the
# line with ALERT_MARKER (src/deploy/alertMarker.ts) and the hook carries it whatever the depth.
#
# ── The invocation id, and why this line carries it ──────────────────────────────────────────────
#
# systemd assigns each START of a unit a 128-bit id and puts it in the service's environment as
# $INVOCATION_ID; the same value is readable from outside as the unit's `InvocationID` property. It
# is the only thing that can prove which run a file on disk belongs to.
#
# deploy/herald-notify-failure.sh needs that proof and had no way to get it. The run logs are named
# by timestamp and it reads the newest by name, so when a unit fails WITHOUT reaching this wrapper —
# a 203/EXEC because pnpm moved, a bad ExecStart=, an unwritable log root — the newest file is the
# PREVIOUS run's, complete with that run's output and its `exited <n>` footer. The alert then
# reported yesterday's failure, with yesterday's exit code, as today's. Recording the id here is
# what lets the hook refuse a file it cannot attribute to the run that just failed.
#
# On the SAME line rather than a new one, deliberately: the hook sends only the last
# LOG_TAIL_LINES lines of this file, so for a short run every extra boundary line costs one line of
# the alert's context — the constraint the NOTE above states. This line already exists; it simply
# says more.
#
# `none` when $INVOCATION_ID is unset (someone running this wrapper by hand, outside systemd) or is
# not the plain hex systemd emits. The hook requires hex, so `none` reads as "unverifiable" to it
# and as an explanation to a human, rather than silently omitting the field and looking like an old
# log. A value with a space in it would break the parse on the other side, which is why this is
# sanitised here rather than trusted.
RUN_INVOCATION="${INVOCATION_ID:-}"
case "$RUN_INVOCATION" in ''|*[!0-9a-f]*) RUN_INVOCATION="none" ;; esac

# Names the unit and the exact command line, which is what makes a run log answerable months later:
# whether `--yes` was passed, which pnpm was on PATH, which subcommand ran.
say "=== $UNIT started $(date -u +%Y-%m-%dT%H:%M:%SZ) invocation $RUN_INVOCATION — $* ==="

if [ -n "$LOG_FILE" ]; then
  # `2>&1` merges stderr into the log: the interesting half of a failed run is almost always there
  # (a stack trace, a pg error), and one chronological stream is what a person reading a past run
  # wants. journald loses the stdout/stderr priority split as a result, which is a fair trade for a
  # log that still exists tomorrow.
  #
  # Nothing may be inserted between this pipeline and the ${PIPESTATUS[0]} read below — not an echo,
  # not a test, not a comment-with-a-command. PIPESTATUS is clobbered by the next command to run.
  "$@" 2>&1 | tee -a "$LOG_FILE"
  STATUS=${PIPESTATUS[0]}
else
  "$@" 2>&1
  STATUS=$?
fi

# No elapsed-time line: bash's SECONDS and EPOCHSECONDS are both wall clock, and a box whose clock
# steps ±23s cannot honestly subtract two of them. Both timestamps are printed; the reader can judge.
say "=== $UNIT exited $STATUS at $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

exit "$STATUS"
