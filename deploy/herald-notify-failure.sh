#!/usr/bin/env bash
# deploy/herald-notify-failure.sh
#
# The OnFailure= target for any scheduled unit that wants this hook (herald-watch.service,
# herald-x-reconcile.service, and any later one), via the templated
# deploy/herald-notify-failure@.service wrapper unit — OnFailure= can only name a unit, never a
# script directly. Each source unit sets its own `OnFailure=herald-notify-failure@%n.service`; `%n`
# expands to the failing unit's own full name before systemd resolves that target, so it becomes the
# template's `%i`, which systemd hands to `ExecStart=` and this script reads as $1. Sends ONE
# Telegram message naming the unit that failed, a short tail of *that* unit's own output — from the
# durable run log deploy/herald-run-logged.sh leaves under %h/.herald/logs/ if there is one, otherwise
# from the journal — and the command to read more, then exits 0 unconditionally once past the
# argument check below: a failure-handler that can itself fail is a loop, not a safety net, and
# nothing here is worth the timer never firing again over.
#
# Takes the failing unit's name as $1 rather than hardcoding it. This used to hardcode
# herald-watch.service, the only unit this hook served at the time; once herald-x-reconcile.service
# needed the same hook, that hardcode meant one of the two would always report the other's unit name
# and tail the other's journal on failure. See deploy/herald-notify-failure@.service's own header
# for the systemd side of this.
#
# Deliberately NOT `set -e`: every failure below (missing .env, missing credentials, curl
# unreachable) must fall through to the unconditional `exit 0` at the bottom, not abort partway and
# report failure to systemd. The one exception is the argument check immediately below, which exits
# non-zero on purpose — see its own comment for why that case is different.
set -uo pipefail

# A UTF-8 locale, because the caps below slice strings and bash slices BYTES unless the locale is a
# multibyte one. systemd gives a user unit no locale at all — none of these units set
# `Environment=LANG=` — so this script runs under C by default, where `${s:0:250}` can cut a Korean
# character or an `✗` in half. The result is a lone continuation byte in the JSON, Telegram answers
# 400, `curl -fsS` fails, and the `|| true` at the bottom swallows it: the alert is never delivered
# and nothing anywhere says so. Both caps in this file have that exposure; the excerpt's predates
# the marked-line block.
#
# Verified by probing rather than assumed, because a locale being NAMED is not a locale being
# INSTALLED — bash silently falls back to C for an unknown name. `é` is one character and two bytes,
# so `${#…} -eq 1` is a direct test of what the caps actually depend on. If none of the candidates
# is installed the script keeps going with byte semantics and caps by whole lines instead of
# slicing (see ALERT_TEXT below), which cannot split anything.
HERALD_UTF8_PROBE=$'é'
HERALD_UTF8=0
if [ "${#HERALD_UTF8_PROBE}" -eq 1 ]; then
  HERALD_UTF8=1
else
  HERALD_SAVED_LC_ALL="${LC_ALL:-}"
  for _cand in C.UTF-8 C.utf8 en_US.UTF-8; do
    export LC_ALL="$_cand"
    if [ "${#HERALD_UTF8_PROBE}" -eq 1 ]; then HERALD_UTF8=1; break; fi
  done
  if [ "$HERALD_UTF8" -eq 0 ]; then
    if [ -n "$HERALD_SAVED_LC_ALL" ]; then export LC_ALL="$HERALD_SAVED_LC_ALL"; else unset LC_ALL; fi
  fi
fi

UNIT="${1:-}"
if [ -z "$UNIT" ]; then
  # Refuse rather than guess. Proceeding with an empty $UNIT would silently repeat the exact bug
  # that made this script take an argument at all, just in a different shape: instead of always
  # naming and tailing herald-watch.service regardless of which unit actually failed, it would name
  # and tail nothing — `journalctl -u ""` reads no unit's journal, and the Telegram message would
  # read "⚠  failed" with no unit at all. That is not a safer fallback, it is the same silent
  # misreport with the specifics removed.
  #
  # This exits non-zero (not the unconditional 0 below) on purpose: a missing $1 means the calling
  # unit's OnFailure=/ExecStart= is wired wrong (or someone ran this by hand without an argument),
  # not one of the downstream conditions — Telegram down, credentials unset, journal unreadable —
  # this script exists to absorb quietly. It should surface as a failed
  # herald-notify-failure@<instance>.service, visible to `systemctl --user --failed`, rather than
  # being swallowed identically to "not configured yet".
  echo "herald-notify-failure.sh: refusing to run — no unit name given as \$1 (systemd's %i)" >&2
  exit 1
fi

# Derived from this script's own location, not hardcoded. Since 2026-08-07 the scheduled units run
# out of the deploy checkout (%h/.herald/app) rather than the development tree, and this script is
# invoked from there too — a hardcoded development path would send it back to read a *different*
# tree's .env. That used to be survivable by accident, because the deploy checkout's .env was a
# symlink into the development tree and the two names resolved to one file. Since 2026-08-09 it is a
# deploy-time copy, so the two genuinely differ the moment anyone edits the development one, and a
# hardcoded path would send this alert with credentials production never ran with — or, once the
# development tree loses its .env, with none. tests/deploy/workingDirectory.test.ts pins this shape.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

# Why an EXCERPT at all, and not just a pointer: pointing the reader at `journalctl` (or `tail`) and
# letting them run it themselves later — the old behaviour, before either source was captured here —
# means the thing that would explain the failure can already be gone by the time anyone reads the
# alert. That risk is real and measured, but it is a JOURNAL risk, not a general one: journald on
# this machine rotates on every backwards clock step (this box's WSL2 + timesyncd combination steps
# the clock constantly), and the readable window has been measured at roughly eight minutes — a run
# that fails late in a long TimeoutStartSec= can already have outlived its own journal by the time
# this hook runs, let alone by the time a human opens the alert. This is why the run log — a file,
# with no rotation window to race at all — is read FIRST below ("Where the excerpt comes from, and
# why the run log wins"), and the journal is read only as a fallback, when there is no run log to
# outrace the clock with. `--output=cat` on the journal reads that follow drops journalctl's own
# timestamp/hostname prefix (redundant here — the alert's own arrival time already says when) so the
# phone-readable budget below goes entirely to the actual message text. Never fatal on its own:
# an unreadable journal (permissions, journald down) degrades to an empty excerpt via `|| true`, not
# a script failure — this hook still has to reach `exit 0` regardless.
# Five lines is a phone-readable budget, and it is a CONTRACT with the commands these units run, not
# just a display choice: a command whose important output is not in its last five lines does not
# appear in the alert at all. `pnpm creds:check` prints a one-line `✗ FAILED: <names>` summary after
# its report for exactly this reason — its report's own `✗` sits nine rows from the end and never
# reached a message. tests/cli/credsCheck.test.ts reads this number out of this file and tails a real
# run log with it, so lowering it fails there rather than silently emptying an alert.
LOG_TAIL_LINES=5
# ── The 30-second budget, and every command that can spend it ────────────────────────────────────
#
# This hook's own wrapper unit sets TimeoutStartSec=30 (deploy/herald-notify-failure@.service).
# Overrunning it is not a slow alert, it is NO alert plus a second failed unit: systemd SIGTERMs the
# hook mid-send, the message is lost, and herald-notify-failure@<unit>.service itself enters
# `failed` — precisely the "a failure-handler that can itself fail is a loop, not a safety net"
# outcome this file's header refuses.
#
# So every external command here that can block is wrapped, and the wrappers are sized as ONE SUM,
# not one at a time. That arithmetic has already been wrong once: it was written for a single curl,
# then the plain-text retry added a second one without redoing it, and the worst case — the
# journal-fallback branch with api.telegram.org unreachable — was MEASURED at 32.04s against the 30s
# deadline. Two seconds past it, so the hook was SIGTERMed mid-retry: alert lost, hook unit failed.
#
#   2 × journalctl  @ JOURNAL_READ_TIMEOUT=6   = 12s   excerpt read + marked-line scan
#   1 × systemctl   @ SYSTEMCTL_READ_TIMEOUT=2 =  2s   the exit-code fallback, far below
#   2 × curl        @ `-m 6` in send_telegram  = 12s   the HTML attempt + the plain-text retry
#                                              ─────
#                                                26s   leaving 4s of margin against 30s.
#
# All three co-occur on one real path: no run log means both journal reads AND the systemctl
# fallback AND, if Telegram is unreachable, both curls. Everything else this script does is local
# text processing, measured end to end at 0.07s against an oversized 256 KiB journal window — so
# that 4s of margin is some fifty times the whole rest of the script.
#
# Any change to any of these three numbers, to the retry count, or to TimeoutStartSec= is a change
# to this sum. Redo it here, and in the unit file's own comment, which states it too.
#
# Measured at exactly 2.00x when the journal reads went from one to two: a journalctl that sleeps
# 20s delivered an alert when there was a single read and is SIGTERMed by systemd when there are
# two — losing the alert entirely, which is worse than losing the marked line. `timeout` returns 124
# on expiry, which the `|| VAR=""` on each read turns into "no lines from this source" — the same
# degradation an unreadable journal already takes.
#
# Resolved rather than assumed present: on a box without `timeout` the reads run unwrapped, exactly
# as they did before, instead of the script dying on a missing command.
JOURNAL_READ_TIMEOUT=6
# `systemctl --user show` talks to the user manager over D-Bus. That manager is alive by definition
# while this hook runs — it is what started it — but it can be busy, and an unbounded third blocking
# command sitting on the same worst-case path is exactly how the sum above went negative the first
# time. 2s against a call measured at 0.007s.
SYSTEMCTL_READ_TIMEOUT=2
if command -v timeout >/dev/null 2>&1; then
  journal_read() { timeout "$JOURNAL_READ_TIMEOUT" journalctl "$@" 2>/dev/null; }
  systemctl_show() { timeout "$SYSTEMCTL_READ_TIMEOUT" systemctl --user show "$@" 2>/dev/null; }
else
  journal_read() { journalctl "$@" 2>/dev/null; }
  systemctl_show() { systemctl --user show "$@" 2>/dev/null; }
fi

# ── What systemd says about the failed unit, asked once ──────────────────────────────────────────
#
# Read here, before anything decides which source to trust, because the first of these three
# properties is what decides it. One call for all three: the budget above counts CALLS, and
# properties are free.
#
#   InvocationID    the 128-bit id systemd assigns to each START of a unit. The only thing that can
#                   prove a file on disk belongs to the run that just failed — see the gate below.
#   ExecMainCode    the waitid(2) si_code: whether ExecMainStatus is a status, a signal, or nothing.
#   ExecMainStatus  the number itself. Both are used by the header block far below.
#
# Asked for as `Name=Value` pairs rather than with `--value`, for two measured reasons. systemctl
# prints properties in ITS order, not the order requested (`-p ActiveState -p SubState -p LoadState
# --value` prints LoadState first), so reading `--value` lines positionally is wrong by
# construction. And it SILENTLY DROPS a name it does not recognise — `-p NoSuchPropertyXyz` yields
# no line and exit 0 — so a typo here would not fail, it would just quietly stop answering. Reading
# by name means a dropped property is an empty value, which every consumer below already treats as
# "unknown"; the test stub honours `-p` for the same reason, so a typo fails a test instead.
UNIT_INVOCATION=""
EXEC_MAIN_CODE=""
EXEC_MAIN_STATUS=""
if command -v systemctl >/dev/null 2>&1; then
  while IFS='=' read -r _k _v; do
    case "$_k" in
      InvocationID) UNIT_INVOCATION="$_v" ;;
      ExecMainCode) EXEC_MAIN_CODE="$_v" ;;
      ExecMainStatus) EXEC_MAIN_STATUS="$_v" ;;
    esac
  done <<< "$(systemctl_show "$UNIT" -p InvocationID -p ExecMainCode -p ExecMainStatus)"
fi
# Plain lowercase hex, 32 characters on this systemd.
#
# The EMPTY case is the load-bearing one and it is checked at the gate below: an unknown unit
# reports `InvocationID=` and empty must never verify anything. The hex test here is belt and
# braces — a non-hex value could not match anyway, since the other side of the comparison is
# extracted by an awk that only accepts `[0-9a-f]+` — and it is kept because it states the shape
# both sides require in the same terms, so the two cannot drift apart silently. Mutation testing
# says so plainly: deleting this line changes no test's outcome, while deleting the empty check
# below fails one immediately.
case "$UNIT_INVOCATION" in ''|*[!0-9a-f]*) UNIT_INVOCATION="" ;; esac

# ── Where the excerpt comes from, and why the run log wins ───────────────────────────────────────
#
# The run log is read FIRST, and this is the whole point of `deploy/herald-run-logged.sh` existing.
#
# journald attributes systemd's own messages about a unit to that unit — `Main process exited`,
# `Failed with result`, `Failed to start`, `Triggering OnFailure=`, `Consumed … CPU time` — and it
# emits them AFTER the process exits, so they are always the last lines. Reading the journal first
# therefore spent the entire five-line budget on systemd talking about itself. A real alert, from
# 2026-08-07, arrived as six lines of which five were that, and nothing about what `pnpm x:reconcile`
# had done wrong. The journal is never empty for a unit that just failed, so the run-log fallback
# below it almost never fired: the wrapper had been writing exactly the right content all along and
# the hook was not looking at it.
#
# The run log holds the command's own output plus the wrapper's two boundary lines, and nothing else.
# It is also one file per run, so the marked-line scan over it is run-scoped by construction —
# the `awk` anchoring further down is needed only on the journal path now.
#
# Newest by NAME, not by mtime: the run logs are UTC-timestamped, `ls -1` sorts them
# lexicographically, and mtime ordering is exactly what this machine's constantly stepping clock
# makes untrustworthy.
#
# Same root expression as the wrapper's, character for character — tests/deploy/runLogging.test.ts
# pins the two equal, because a wrapper writing where this hook does not look is a fallback that
# silently never fires while both scripts keep passing their own tests.
LOG_EXCERPT=""
LOG_POINTER=""
EXCERPT_SOURCE="none"
RUN_LOG=""

LOG_ROOT="${HERALD_LOG_DIR:-${HOME:-}/.herald/logs}"
RUN_LOG_DIR="$LOG_ROOT/${UNIT%.service}"
RUN_LOG="$(ls -1 "$RUN_LOG_DIR"/*.log 2>/dev/null | tail -n 1)" || RUN_LOG=""

# ── Prove the file is THIS run's, or do not use it ───────────────────────────────────────────────
#
# "Newest by name" is not "this run's". The two come apart exactly when the unit fails WITHOUT
# reaching deploy/herald-run-logged.sh — a 203/EXEC because pnpm moved, a bad ExecStart=, an
# unwritable log root — because then no file is written for this run at all and the newest one is
# the PREVIOUS run's, with its output and its `exited <n>` footer intact. The alert reported
# yesterday's failure, with yesterday's exit code, as today's, and today's real status (203) was
# discarded. It reads entirely plausible, which is what makes it the worst failure mode this hook
# has: a confident, specific, wrong answer.
#
# Nothing in the file's name, mtime or content could distinguish the two — this box's clock steps,
# so even an mtime within the last second proves nothing. systemd's invocation id can: it changes on
# every start of the unit, the wrapper records the one it ran under in its header line, and the hook
# asks systemd for the unit's current one. Equal, or the file is not this run's.
#
# THE RULE IS ALL-OR-NOTHING, and deliberately so: an unverifiable file is dropped for the excerpt
# AND for the exit code, not special-cased for one of them. Both were stale together, from the same
# file, and a gate that saved only the number would still have shipped yesterday's output.
#
# Three ways to fail it, all landing on the journal:
#   - the file records no id (`none`, or a log written before the wrapper recorded one). UNUSABLE,
#     on purpose. Trusting an unverifiable file is the bug. The transition costs nothing to wait
#     out: herald-run-logged.sh keeps 60 runs per unit and these units run daily to two-hourly, so
#     every id-less log ages out on its own within days. Do NOT "fix" this by trusting them.
#   - the ids differ. The file is a previous run's, which is the case above.
#   - systemd could not be asked at all — no systemctl, no bus, the 2s `timeout` expiring. Then
#     nothing can be verified and the journal is taken. Losing the run log's formatting is
#     survivable; presenting yesterday's failure as today's is not.
#
# Said on stderr rather than in the message: it lands in `journalctl --user -u
# herald-notify-failure@<unit>.service` next to curl's own `-S` errors, so "why is this alert
# journal-shaped when a run log exists?" is answerable, without spending a line of the phone budget
# on it for every unit during the transition.
#
# `head -n 1`: the wrapper writes this line before it runs anything, so the first line is the only
# place its own header can be. A line further down carrying the same shape came from the command's
# output, and a same-second name collision (`tee -a` appends rather than clobbers) leaves the OLDER
# run's header first — which fails the check and takes the journal, the safe direction.
if [ -n "$RUN_LOG" ]; then
  RUN_LOG_INVOCATION="$(head -n 1 "$RUN_LOG" 2>/dev/null | awk -v marker="=== ${UNIT} started " '
    index($0, marker) == 1 && match($0, / invocation [0-9a-f]+ /) {
      print substr($0, RSTART + 12, RLENGTH - 13)
    }
  ')" || RUN_LOG_INVOCATION=""
  if [ -z "$UNIT_INVOCATION" ] || [ "$RUN_LOG_INVOCATION" != "$UNIT_INVOCATION" ]; then
    echo "herald-notify-failure.sh: ignoring ${RUN_LOG} — cannot prove it is this run's (log invocation '${RUN_LOG_INVOCATION:-none}', unit invocation '${UNIT_INVOCATION:-unknown}'); using the journal instead" >&2
    RUN_LOG=""
  fi
fi

if [ -n "$RUN_LOG" ]; then
  LOG_EXCERPT="$(tail -n "$LOG_TAIL_LINES" "$RUN_LOG" 2>/dev/null)" || LOG_EXCERPT=""
  if [ -n "$LOG_EXCERPT" ]; then
    LOG_POINTER="tail -n 50 ${RUN_LOG}"
    EXCERPT_SOURCE="runlog"
  fi
fi

# Journal fallback: the unit never reached the wrapper (a misconfigured ExecStart=, a unit added
# without it), or could not write under %h/.herald/logs. Captured with `--output=cat` to drop
# journalctl's own timestamp/hostname prefix — redundant here, since the alert's arrival time
# already says when. Never fatal on its own: an unreadable journal degrades to an empty excerpt via
# `|| true`, not a script failure. This hook still has to reach `exit 0` regardless.
if [ -z "$LOG_EXCERPT" ]; then
  LOG_EXCERPT="$(journal_read --user -u "$UNIT" -n "$LOG_TAIL_LINES" --no-pager --output=cat)" || LOG_EXCERPT=""
  if [ -n "$LOG_EXCERPT" ]; then
    LOG_POINTER="journalctl --user -u ${UNIT} -n 50 --no-pager"
    EXCERPT_SOURCE="journal"
  fi
fi

# Neither source had anything. The pointer is still worth sending — it is what the excerpt exists to
# make unnecessary, not a replacement for it.
[ -z "$LOG_POINTER" ] && LOG_POINTER="journalctl --user -u ${UNIT} -n 50 --no-pager"

# ── Marked lines: content the failing command declared must reach the alert ──────────────────────
#
# Everything above locates the interesting output by counting lines from the end. That is a
# positional heuristic and it has already failed once, on the one unit whose important line is at the
# top rather than the bottom: `pnpm creds:check` prints a seven-line report, so the `✗` naming the
# dead credential sat nine rows from the end and the alert carried two green ticks and a count.
# Printing a summary line last fixed that run and left one line of slack — on the journal branch
# systemd's own `Main process exited` / `Failed with result` / `Failed to start` lines put it at
# position 1 of 5, so one more systemd line (`Consumed 1.234s CPU time` is a real one) empties the
# alert again, silently.
#
# So a command can declare a line instead: anything printed with the ALERT_MARKER prefix is carried
# into the message regardless of LOG_TAIL_LINES. The prefix is stripped before sending, so it costs
# the message nothing, and marked lines are removed from the tail below rather than repeated.
#
# PURELY ADDITIVE. The other three units emit no marker, so every variable below stays empty for
# them and their payload is byte-identical to what it was before this block existed — verified by
# capturing and diffing real payloads, not by reasoning. `src/deploy/alertMarker.ts` holds the same
# string on the TypeScript side and tests/deploy/notifyFailureMarker.test.ts pins the two equal.
#
# A SECOND read of the same source rather than widening the excerpt's own: reusing that read and
# re-tailing it would change how LOG_EXCERPT is produced for every unit, which is exactly what must
# not change here. This one is bounded and its failure degrades to "no marked lines", never to a
# script error.
ALERT_MARKER="HERALD_ALERT: "
# How far back to look for marked lines. Well past LOG_TAIL_LINES, because the whole point is that
# the line may be nowhere near the end; bounded because this is a log of unknown length.
ALERT_SCAN_LINES=200
# A LINE bound is not a SIZE bound, and on the journal branch this read still runs regardless of
# whether the unit marks any lines — every unit that falls through to the journal pays whatever it
# costs. Measured: 200 lines of 1 MiB each took 26.46s and 1,039 MB RSS against 1.00s and 216 MB for
# the single read before, crossing TimeoutStartSec= at around 246 MB of journal. `head -c` puts the
# ceiling where bash can enforce it. 256 KiB is a thousand times any real run and still nothing. A
# unit whose run log answered the excerpt never takes this journal branch at all — see below.
ALERT_SCAN_MAX_BYTES=262144
# What the mechanism may add to the message, so a log full of marked lines cannot produce an
# unbounded Telegram message. Three lines is more than any command emits today (creds:check emits
# one); the character cap is the one that actually binds, and it is half the excerpt's own.
ALERT_MAX_LINES=3
ALERT_MAX_CHARS=250

# `|| true` inside the group, not after the pipeline: `head -c` closes the pipe once it has enough,
# journalctl dies of SIGPIPE, and with `pipefail` that would discard a window that was merely
# truncated — turning the byte cap into a silent off switch.
#
# Same source precedence as the excerpt above, and for the same reason: scan whichever source
# EXCERPT_SOURCE says actually answered — the run log first, the journal only when that came back
# empty — rather than always widening a journal read regardless of where the excerpt came from. This
# is also what keeps the journal read above conditional in practice: a unit whose run log answered
# skips it entirely.
if [ "$EXCERPT_SOURCE" = "runlog" ]; then
  ALERT_WINDOW="$( { tail -n "$ALERT_SCAN_LINES" "$RUN_LOG" 2>/dev/null || true; } | head -c "$ALERT_SCAN_MAX_BYTES" )" || ALERT_WINDOW=""
else
  ALERT_WINDOW="$( { journal_read --user -u "$UNIT" -n "$ALERT_SCAN_LINES" --no-pager --output=cat || true; } | head -c "$ALERT_SCAN_MAX_BYTES" )" || ALERT_WINDOW=""
fi

# ── Scope the window to THIS run ─────────────────────────────────────────────────────────────────
#
# The five-line tail was implicitly run-scoped; a 200-line window is not, and the journal is one
# continuous stream per unit. A creds:check run is 18 lines, so about eleven previous daily runs fit
# inside the window: a run that exits 2 today — a machine-configuration error naming no credential
# at all — would headline YESTERDAY's `✗ FAILED: live: google_auth`, and three consecutive failing
# days would headline three different credentials from three different days. The most confident line
# in the message, about the wrong day.
#
# deploy/herald-run-logged.sh writes `=== <unit> started <ts> — <cmd> ===` before every run, so the
# boundary already exists in both sources. Everything after the LAST such line is this run.
#
# Three cases, all deliberate:
#   - no start line in the window: the run is longer than the window, or predates the wrapper.
#     Promote NOTHING. The alert falls back to exactly the five-line tail it sent before this
#     mechanism existed, which is a known-correct message rather than a guess about which run a line
#     came from.
#   - a start line with no exit line after it: the run failing right now. Nothing special — the exit
#     line is not what scopes anything, the start line is.
#   - two or more start lines: the last one wins, by construction.
#
# The run-log branch is NOT scoped this way, and must not be: that file is one run by definition, and
# running the same filter over it would promote nothing whenever a log predates the wrapper's header
# — trading a correct message for an empty one.
ALERT_SCOPE="$ALERT_WINDOW"
ALERT_UNSCOPED=0
if [ "$EXCERPT_SOURCE" = "journal" ] && [ -n "$ALERT_WINDOW" ]; then
  ALERT_SCOPE="$(printf '%s\n' "$ALERT_WINDOW" | awk -v marker="=== ${UNIT} started " '
    index($0, marker) == 1 { buf = ""; found = 1; next }
    found { buf = buf $0 "\n" }
    END { if (found) printf "%s", buf }
  ')" || ALERT_SCOPE=""
  [ -z "$ALERT_SCOPE" ] && ALERT_UNSCOPED=1
fi

# Marked lines, newest first-served, matched past leading whitespace. A marked line indented by even
# one space used to be neither promoted NOR stripped, so the raw `HERALD_ALERT: ` prefix reached the
# phone and the credential could be lost from the promoted position at the same time.
ALERT_RAW=""
ALERT_TEXT=""
if [ -n "$ALERT_SCOPE" ]; then
  ALERT_RAW="$(printf '%s\n' "$ALERT_SCOPE" | grep "^[[:space:]]*${ALERT_MARKER}" | tail -n "$ALERT_MAX_LINES")" || ALERT_RAW=""
  if [ -n "$ALERT_RAW" ]; then
    ALERT_TEXT="$(printf '%s\n' "$ALERT_RAW" | sed "s/^[[:space:]]*${ALERT_MARKER}//")" || ALERT_TEXT=""
  fi
  if [ "$HERALD_UTF8" -eq 1 ]; then
    if [ "${#ALERT_TEXT}" -gt "$ALERT_MAX_CHARS" ]; then
      ALERT_TEXT="${ALERT_TEXT:0:$ALERT_MAX_CHARS}…(truncated)…"
    fi
  else
    # No multibyte locale: cap by dropping whole lines rather than slicing, which cannot split a
    # character. Cruder, and only reachable on a box with no UTF-8 locale installed at all.
    while [ "${#ALERT_TEXT}" -gt "$ALERT_MAX_CHARS" ] && [ "$ALERT_TEXT" != "${ALERT_TEXT%$'\n'*}" ]; do
      ALERT_TEXT="${ALERT_TEXT%$'\n'*}"
    done
  fi
fi

# Did the scan hit its own ceiling? Only said out loud when this unit marks lines at all, so a unit
# that uses none of this keeps a byte-identical payload. Silence here was the remaining cliff: a
# marked line one line past the window, or a run longer than it, produced the legacy alert with
# nothing indicating that anything had been looked for and missed.
ALERT_NOTE=""
if [ -n "$ALERT_WINDOW" ] && printf '%s\n' "$ALERT_WINDOW" | grep -q "^[[:space:]]*${ALERT_MARKER}"; then
  ALERT_WINDOW_LINES="$(printf '%s\n' "$ALERT_WINDOW" | wc -l)"
  if [ "$ALERT_WINDOW_LINES" -ge "$ALERT_SCAN_LINES" ] || [ "${#ALERT_WINDOW}" -ge "$ALERT_SCAN_MAX_BYTES" ]; then
    if [ "$ALERT_UNSCOPED" -eq 1 ]; then
      ALERT_NOTE="(this run is longer than the ${ALERT_SCAN_LINES}-line scan window — no marked line could be attributed to it)"
    else
      ALERT_NOTE="(scan window full at ${ALERT_SCAN_LINES} lines — older marked lines, if any, were not read)"
    fi
  elif [ "$ALERT_UNSCOPED" -eq 1 ]; then
    ALERT_NOTE="(marked lines were found but belong to an earlier run of this unit, so none was promoted)"
  fi
fi

# Marked lines are shown once, above the tail — but PROMOTE-OR-KEEP, never promote-or-delete. This
# used to strip every marked line from the excerpt while promoting at most ALERT_MAX_LINES of them,
# so five marked lines inside a five-line tail meant two credentials vanished from a message the
# pre-marker script delivered in full. Only the lines actually promoted are dropped; any other marked
# line stays where it is, with its prefix removed so the raw marker never reaches the phone.
if [ -n "$LOG_EXCERPT" ]; then
  LOG_EXCERPT="$(
    promoted=$'\n'"${ALERT_RAW}"$'\n'
    kept=""
    while IFS= read -r _line; do
      if [ -n "$ALERT_RAW" ]; then
        case "$promoted" in
          *$'\n'"$_line"$'\n'*) continue ;;
        esac
      fi
      kept="${kept}${_line}"$'\n'
    done <<< "$LOG_EXCERPT"
    printf '%s' "${kept%$'\n'}"
  )" || LOG_EXCERPT=""
  # Display-strip any marked line that survived, so a line that was kept rather than promoted is
  # readable instead of carrying machinery the operator never needs to see.
  LOG_EXCERPT="$(printf '%s\n' "$LOG_EXCERPT" | sed "s/^\([[:space:]]*\)${ALERT_MARKER}/\1/")" || LOG_EXCERPT=""
fi

# Cap the excerpt independent of how long the captured lines actually are — a single stack-trace
# or a long `claude -p` error can dwarf a phone screen on its own. Keeps the tail (the most recent,
# and usually most relevant, output) rather than the head.
LOG_EXCERPT_MAX_CHARS=500
if [ "${#LOG_EXCERPT}" -gt "$LOG_EXCERPT_MAX_CHARS" ]; then
  LOG_EXCERPT="…(truncated)…${LOG_EXCERPT: -$LOG_EXCERPT_MAX_CHARS}"
fi

# Telegram credentials live in the repo's own .env — the same file `pnpm watch` reads via
# `tsx --env-file-if-exists=.env` — not in ~/.herald/prod.env, which holds only DATABASE_URL and
# HERALD_DB_ENV (see herald-watch.service's own comment). This unit is a separate process from
# `pnpm watch`, so nothing hands it that environment automatically; it has to read the file itself.
#
# Reads the line it needs directly rather than `source`-ing the whole file: .env is dotenv-format,
# not shell syntax, and this script has no business executing the couple hundred other lines in it
# just to read two variables. Handles the three ways this can otherwise disagree with how Node's
# own `--env-file` parses the same file (verified against synthetic examples, not assumed):
#   - `KEY="value"` / `KEY='value'` — Node strips one matching pair of surrounding quotes; a bare
#     grep+cut would hand the quotes themselves to curl as part of the token/chat id.
#   - `export KEY=value` — Node accepts the shell-style `export ` prefix; a plain `^KEY=` anchor
#     would not match the line at all and silently read as unset.
#   - a CRLF line ending — Node trims it; a bare grep+cut would leave a trailing \r baked into the
#     value (invisible in a terminal, but a literal byte in the HTTP request built below).
# Not attempted: nested/escaped quotes, multi-line values, variable interpolation — none of which
# this repo's own .env uses for these two variables, and full dotenv-parity is not the goal here.
read_env_var() {
  [ -f "$ENV_FILE" ] || return 0
  local line
  line="$(grep -m1 -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$ENV_FILE" 2>/dev/null)" || return 0
  line="${line%$'\r'}"    # CRLF line ending
  line="${line#*=}"       # strip the "[export ]KEY=" prefix — cuts at the first '=' in the line
  if [[ "$line" == \"*\" && "$line" == *\" ]] || [[ "$line" == \'*\' && "$line" == *\' ]]; then
    line="${line:1:${#line}-2}"    # one matching pair of surrounding quotes, same as Node's parser
  fi
  printf '%s' "$line"
}

TELEGRAM_BOT_TOKEN="$(read_env_var TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID_OPS="$(read_env_var TELEGRAM_CHAT_ID_OPS)"

# Minimal JSON-string escaping for $TEXT below: the captured log excerpt is the failed unit's own
# output, not attacker input, but it is not format-free either — a stray `"` or `\` from a stack
# trace, or the newline this script itself inserts between the excerpt and the journalctl pointer,
# would otherwise land unescaped inside the hand-built payload a few lines down (built with
# printf, not a JSON library). Unescaped, either the message Telegram receives is corrupted or the
# request body stops being valid JSON and curl's -fsS turns that into a silent send failure — the
# same "alert looks sent but says nothing useful" outcome this whole hook exists to prevent for
# herald-watch.service itself, just one layer further in.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\r'/}
  s=${s//$'\n'/\\n}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# HTML entity escaping, for `parse_mode: "HTML"`. Only three characters need it — the repo settled
# on HTML over MarkdownV2 for exactly that reason (src/domain/formatting/emitters/telegram.ts:29:
# MarkdownV2 needs 18, including `.`, `(`, `)` and `-`, all of which saturate Korean prose).
#
# `&` FIRST, or the ampersands this function itself introduces get escaped a second time and the
# operator reads `&amp;lt;`.
#
# The `&` in each replacement is written `\&`, not `&`, and that backslash is not decorative: since
# bash 5.2, `${s//pattern/string}` treats a bare `&` in `string` as sed does — "the text that just
# matched" — so `s=${s//</&lt;}` would substitute `<` with `<lt;` (the matched `<` followed by
# `lt;`), never inserting the ampersand at all. Verified on this box's bash 5.2.21, where the
# unescaped version passed a naive read of this function while silently emitting `<lt;…>gt;` — the
# exact unescaped-`<` failure mode this function exists to prevent, coming from the escaper itself.
#
# This is not cosmetic. An unescaped `<` in a log line makes the message malformed HTML, Telegram
# answers 400, and `curl -fsS … || true` below discards that — so the alert disappears with no
# trace at either end. The plain-text retry further down is the second half of this guard; neither
# replaces the other, because escaping is what a future edit can get wrong and the retry is what
# makes getting it wrong survivable.
#
# Composes with, and does not replace, `sanitizeWireText` (src/deploy/describeValue.ts) upstream in
# the TypeScript layer: that one stops a wire string from forging a `HERALD_ALERT: ` marker line;
# this one stops it from forging HTML markup. Neither is a substitute for the other.
html_escape() {
  local s=$1
  s=${s//&/\&amp;}
  s=${s//</\&lt;}
  s=${s//>/\&gt;}
  printf '%s' "$s"
}

# Unset means: no scheduler-failures room configured yet (.env.example documents it as
# [REQUIRED for the pnpm watch scheduler's failure hook], but nothing enforces that before the
# timer is installed). Exiting 0 with nothing sent is the same fail-safe posture as a Telegram
# outage below — this hook never turns "not configured yet" into a failed systemd unit.
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID_OPS" ]; then
  # ── Which exit code the header names, and who gets asked ───────────────────────────────────────
  #
  # The exit code separates a dead credential (1) from a machine-configuration error (2), and the
  # operator should not have to infer which from the body. Two sources can answer, and the order is
  # the same judgment the excerpt makes above: OUR OWN ARTIFACT FIRST, systemd's account of it
  # second.
  #
  # 1. The run log's footer — `=== <unit> exited <n> at … ===`, written by
  #    deploy/herald-run-logged.sh from ${PIPESTATUS[0]}, i.e. the status the wrapper actually saw,
  #    in shell convention (a signalled command is already 128+N there). All four units this hook
  #    serves run through that wrapper, so in production this is the branch that answers.
  #
  #    $RUN_LOG is the same single file the excerpt is quoting, and it has already been PROVEN to
  #    belong to this run — see the invocation-id gate above, which empties $RUN_LOG when it cannot
  #    prove that. So there is nothing left for this block to second-guess: if the variable is set,
  #    the footer in it is this run's footer. That gate is also why preferring the footer is safe at
  #    all; without it, "the newest file by name" and "this run" come apart precisely when a unit
  #    fails before reaching the wrapper, and this block would have named the previous run's code.
  #
  # 2. systemd, and only as the FALLBACK, because `systemctl --user show <unit> -p ExecMainStatus`
  #    NEVER returns empty. For a unit it has never heard of it prints `0` and exits 0 — measured on
  #    this box:
  #        $ systemctl --user show herald-nope.service -p ExecMainCode -p ExecMainStatus
  #        ExecMainCode=0
  #        ExecMainStatus=0
  #    A guard that only rejected a NON-NUMERIC value therefore accepted that `0`, and the alert
  #    read `⚠ <unit> 실패 (exit 0)` — a header contradicting itself about a real failure — while
  #    `[ -z "$EXIT_CODE" ]` was never true, making the run-log branch dead code in production.
  #    Reproduced end to end before this was rewritten, not reasoned about.
  #
  #    ExecMainCode is what separates the cases. It is the waitid(2) si_code, so:
  #        0    → no main process was ever reaped. Nothing is known; NO code in the header.
  #        1    → CLD_EXITED. ExecMainStatus is a genuine exit status.
  #        2, 3 → CLD_KILLED / CLD_DUMPED. ExecMainStatus is a SIGNAL NUMBER, not a status: a unit
  #               killed on its own TimeoutStartSec= reports 15, and `(exit 15)` names a code the
  #               command never returned — while the wrapper's own footer, for the same run, says
  #               143. Converted to 128+N here so the two agree whichever one answers.
  #
  #    $EXEC_MAIN_CODE and $EXEC_MAIN_STATUS were read at the top of the script, in the same single
  #    `systemctl show` the invocation-id gate needed — see that block for why the properties are
  #    read by name rather than with `--value`.
  EXIT_CODE=""
  if [ -n "$RUN_LOG" ]; then
    # Through `tail`, not straight at the file: the footer is the LAST thing herald-run-logged.sh
    # writes, and every other read of this file is capped for a reason — a wedged run under an
    # 1800s TimeoutStartSec= can leave a very large log. Measured on a 100 MB one: 0.004s this way
    # against 0.232s reading the whole thing, and unlike the 0.232s this one does not grow.
    #
    # awk with `-v`, not `sed` with an interpolated "$UNIT": in a BRE the dots of
    # `herald-creds.service` are wildcards and a `/` would close the `s///` delimiter early. awk's
    # index() against a -v variable is a literal comparison with no metacharacters at all — the same
    # reason the run-scoping awk further up takes its marker that way. Last footer wins; the ` at `
    # suffix is matched so a line that merely starts the same way cannot contribute a number.
    EXIT_CODE="$(tail -n "$LOG_TAIL_LINES" "$RUN_LOG" 2>/dev/null | awk -v marker="=== ${UNIT} exited " '
      index($0, marker) == 1 {
        rest = substr($0, length(marker) + 1)
        if (match(rest, /^[0-9]+ at /)) code = substr(rest, 1, RLENGTH - 4)
      }
      END { if (code != "") print code }
    ')" || EXIT_CODE=""
  fi

  if [ -z "$EXIT_CODE" ]; then
    case "$EXEC_MAIN_STATUS" in ''|*[!0-9]*) EXEC_MAIN_STATUS="" ;; esac
    if [ -n "$EXEC_MAIN_STATUS" ]; then
      case "$EXEC_MAIN_CODE" in
        1) EXIT_CODE="$EXEC_MAIN_STATUS" ;;
        2|3) EXIT_CODE="$((128 + EXEC_MAIN_STATUS))" ;;
      esac
    fi
  fi

  # Whichever source answered: `⚠ <unit> 실패 (exit 0)` is a sentence that contradicts itself, and 0
  # is exactly what an unknown unit reports. Unknown degrades to a header with NO code — which is
  # what this block has always claimed to do and, until this was fixed, did not.
  [ "$EXIT_CODE" = "0" ] && EXIT_CODE=""

  HEADER="⚠ ${UNIT} 실패"
  [ -n "$EXIT_CODE" ] && HEADER="${HEADER} (exit ${EXIT_CODE})"

  # Header, then anything promoted, then the note if there is one, then the tail, then the pointer.
  # Assembled by appending so the three optional pieces cannot multiply into branches — the earlier
  # shape had one branch per combination and lost a case the moment ALERT_NOTE was added.
  #
  # Header and marked lines are plain: they are the part that must stay readable when a phone is
  # narrow, and `<pre>` would let them scroll off to the right. The excerpt is `<pre>` because the
  # reports these units print are column-aligned and proportional text ruins them.
  if [ -n "$ALERT_TEXT" ] || [ -n "$ALERT_NOTE" ] || [ -n "$LOG_EXCERPT" ]; then
    TEXT="$(html_escape "$HEADER")"
    [ -n "$ALERT_TEXT" ] && TEXT="${TEXT}
$(html_escape "$ALERT_TEXT")"
    [ -n "$ALERT_NOTE" ] && TEXT="${TEXT}
$(html_escape "$ALERT_NOTE")"
    [ -n "$LOG_EXCERPT" ] && TEXT="${TEXT}
<pre>$(html_escape "$LOG_EXCERPT")</pre>"
    TEXT="${TEXT}
↳ $(html_escape "$LOG_POINTER")"
  else
    # Neither source had anything: the journal was already rotated (or unreadable), AND there is no
    # durable run log — the unit never reached deploy/herald-run-logged.sh, or could not write under
    # %h/.herald/logs. Still send the alert; the pointer is the fallback the excerpt exists to make
    # unnecessary, not a replacement for it.
    TEXT="$(html_escape "${HEADER} — 실행 로그도 저널도 남지 않았습니다")
↳ $(html_escape "$LOG_POINTER")"
  fi

  # One attempt as HTML, and — only if Telegram REJECTED it — one as plain text with the tags
  # stripped.
  #
  # -4: this machine's IPv6 route to api.telegram.org is known broken while the AAAA record still
  # resolves (see src/cli/preferIpv4.ts) — curl itself is unaffected by that bug, but there is no
  # reason to let Happy Eyeballs race a dead route on every failure notice. -fsS: non-zero exit on
  # an HTTP error, quiet on stdout, but -S still prints the error to stderr — deliberately NOT
  # redirected, so a 401 on a stale token or a 400 on malformed HTML lands in `journalctl --user -u
  # herald-notify-failure@${UNIT}.service` instead of vanishing along with the message that never
  # sent.
  #
  # `-m 6`, not the 10 this used to be, and the difference is the retry: this function is now called
  # TWICE on the worst path, so its budget is spent twice. See "The 30-second budget" at the top —
  # 2×6 is the largest per-attempt value that keeps the whole hook inside TimeoutStartSec=30 with
  # margin. A hung request must not hold the unit open; two hung requests must not either.
  send_telegram() {
    local text=$1 mode=$2 payload
    if [ -n "$mode" ]; then
      payload="$(printf '{"chat_id":"%s","text":"%s","parse_mode":"%s"}' \
        "$TELEGRAM_CHAT_ID_OPS" "$(json_escape "$text")" "$mode")"
    else
      payload="$(printf '{"chat_id":"%s","text":"%s"}' \
        "$TELEGRAM_CHAT_ID_OPS" "$(json_escape "$text")")"
    fi
    curl -4 -fsS -m 6 \
      -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "$payload" \
      >/dev/null
  }

  # Nothing may run between these two lines: $? is clobbered by the next command, and the retry
  # decision below is about WHICH failure this was, not merely that there was one.
  send_telegram "$TEXT" "HTML"
  SEND_RC=$?

  # 22, and nothing else. `curl -f` exits 22 on an HTTP status >= 400, which is the only failure
  # class a plain-text resend can fix — a 400 on malformed HTML. Retrying any other class is
  # actively harmful, not merely useless:
  #   6   (DNS) and 28 (`-m` expired) spend the whole curl budget a second time against the deadline
  #       above; the 32.04s overrun that budget comment describes was exactly this, an unreachable
  #       api.telegram.org retried for no reason that could ever have worked.
  #   28  can also DUPLICATE the alert: `-m` expiring after Telegram already accepted the message
  #       means the retry posts the same content again, and the operator gets it twice.
  #   127 (curl not installed) cannot succeed on a second call either.
  #   A 401 on a stale token is a 22, and re-sending identical content earns the identical 401 —
  #       one wasted call, bounded, and the price of not special-casing status codes curl does not
  #       hand back separately.
  if [ "$SEND_RC" -eq 22 ]; then
    # Formatting cost us the message. Send the content unformatted rather than nothing: `<pre>` tags
    # out, entities back to their characters, no parse_mode. One retry, not a loop — the second
    # attempt uses the encoding that worked before this change, so a second failure is not about
    # formatting and repeating would only delay `exit 0`.
    #
    # Reverse order from html_escape on purpose: `&lt;`/`&gt;` must give back `<`/`>` before `&amp;`
    # gives back `&`, or an original `&lt;` (escaped by html_escape to `&amp;lt;`) would have its
    # `&amp;` collapsed to `&` first and stop matching `&lt;` at all, leaving a literal `&lt;` in the
    # "plain text" retry. And `&` in the final replacement is written `\&`: the same bash-5.2
    # matched-text meaning that bit html_escape above bites here too — `${PLAIN//&amp;/&}` would
    # replace `&amp;` with itself (a no-op), not with `&`.
    PLAIN=${TEXT//<pre>/}
    PLAIN=${PLAIN//<\/pre>/}
    PLAIN=${PLAIN//&lt;/<}
    PLAIN=${PLAIN//&gt;/>}
    PLAIN=${PLAIN//&amp;/\&}
    send_telegram "$PLAIN" "" || true
  fi
fi

exit 0
