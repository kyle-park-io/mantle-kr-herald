#!/usr/bin/env bash
# deploy/herald-notify-failure.sh
#
# The OnFailure= target for herald-watch.service (via the deploy/herald-notify-failure.service
# wrapper unit — OnFailure= can only name a unit, never a script directly). Sends ONE Telegram
# message naming the unit that failed, a short tail of its own journal captured right now, and the
# `journalctl` command to read more, then exits 0 unconditionally: a failure-handler that can
# itself fail is a loop, not a safety net, and nothing here is worth the timer never firing again
# over.
#
# Hardcodes the one unit this ever fires for (herald-watch.service). Generalise only once a second
# scheduled unit needs the same hook: turn this into `herald-notify-failure@.service` (`%i` as the
# instance), accept the unit name as $1 here, and set the source unit's
# `OnFailure=herald-notify-failure@%N.service`.
#
# Deliberately NOT `set -e`: every failure below (missing .env, missing credentials, curl
# unreachable) must fall through to the unconditional `exit 0` at the bottom, not abort partway
# and report failure to systemd.
set -uo pipefail

REPO_DIR="/home/kyle/code/mantle-kr-herald"
ENV_FILE="$REPO_DIR/.env"
UNIT="herald-watch.service"

# Captured immediately, before anything else in this script runs, because it may not be readable
# for long: journald on this machine rotates on every backwards clock step (this box's WSL2 +
# timesyncd combination steps the clock constantly), and the readable window has been measured at
# roughly eight minutes. Pointing the reader at `journalctl` and letting them run it themselves
# later — the old behaviour — means the thing that would explain the failure can already be gone
# by the time anyone reads the alert. `--output=cat` drops journalctl's own timestamp/hostname
# prefix (redundant here — the alert's own arrival time already says when) so the phone-readable
# budget below goes entirely to the actual message text. Never fatal on its own: an unreadable
# journal (permissions, journald down) degrades to an empty excerpt via `|| true`, not a script
# failure — this hook still has to reach `exit 0` regardless.
LOG_TAIL_LINES=5
LOG_EXCERPT="$(journalctl --user -u "$UNIT" -n "$LOG_TAIL_LINES" --no-pager --output=cat 2>/dev/null)" || LOG_EXCERPT=""

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

# Unset means: no scheduler-failures room configured yet (.env.example documents it as
# [REQUIRED for the pnpm watch scheduler's failure hook], but nothing enforces that before the
# timer is installed). Exiting 0 with nothing sent is the same fail-safe posture as a Telegram
# outage below — this hook never turns "not configured yet" into a failed systemd unit.
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID_OPS" ]; then
  if [ -n "$LOG_EXCERPT" ]; then
    TEXT="⚠ ${UNIT} failed
${LOG_EXCERPT}
— journalctl --user -u ${UNIT} -n 50 --no-pager"
  else
    # journalctl above returned nothing (or failed outright) — still send the alert; the pointer
    # is the fallback the excerpt exists to make unnecessary, not a replacement for it.
    TEXT="⚠ ${UNIT} failed (no journal lines captured) — journalctl --user -u ${UNIT} -n 50 --no-pager"
  fi
  # -4: this machine's IPv6 route to api.telegram.org is known broken while the AAAA record still
  # resolves (see src/cli/preferIpv4.ts) — curl itself is unaffected by that bug, but there is no
  # reason to let Happy Eyeballs race a dead route on every failure notice. -m 10: a hung request
  # here must not hold the unit open; -fsS: fail (non-zero exit) on an HTTP error, silent on
  # stdout otherwise, but -S still prints the error to stderr — deliberately NOT redirected to
  # /dev/null (a 2>&1 here would make -S pointless), so a 401 on a stale token, a 400 on a bad chat
  # id, or any other Telegram-side rejection lands in `journalctl --user -u
  # herald-notify-failure.service` instead of vanishing along with the message that never sent.
  curl -4 -fsS -m 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id":"%s","text":"%s"}' "$TELEGRAM_CHAT_ID_OPS" "$(json_escape "$TEXT")")" \
    >/dev/null || true
fi

exit 0
