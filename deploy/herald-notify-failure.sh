#!/usr/bin/env bash
# deploy/herald-notify-failure.sh
#
# The OnFailure= target for herald-watch.service (via the deploy/herald-notify-failure.service
# wrapper unit — OnFailure= can only name a unit, never a script directly). Sends ONE line to
# Telegram naming the unit that failed and the journalctl command to read why, then exits 0
# unconditionally: a failure-handler that can itself fail is a loop, not a safety net, and nothing
# here is worth the timer never firing again over.
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

# Unset means: no scheduler-failures room configured yet (.env.example documents it as
# [REQUIRED for the pnpm watch scheduler's failure hook], but nothing enforces that before the
# timer is installed). Exiting 0 with nothing sent is the same fail-safe posture as a Telegram
# outage below — this hook never turns "not configured yet" into a failed systemd unit.
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID_OPS" ]; then
  TEXT="⚠ ${UNIT} failed — journalctl --user -u ${UNIT} -n 50 --no-pager"
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
    -d "$(printf '{"chat_id":"%s","text":"%s"}' "$TELEGRAM_CHAT_ID_OPS" "$TEXT")" \
    >/dev/null || true
fi

exit 0
