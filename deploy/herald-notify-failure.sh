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
# Reads the two lines it needs with grep+cut rather than `source`-ing the whole file: .env is
# dotenv-format, not shell syntax, and this script has no business executing the couple hundred
# other lines in it (nor risking a value that isn't valid shell) just to read two variables.
read_env_var() {
  [ -f "$ENV_FILE" ] || return 0
  grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d '=' -f2-
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
  # here must not hold the unit open; -fsS: fail on HTTP errors, silent otherwise, but still let
  # stderr through for `journalctl` to capture on a genuine failure.
  curl -4 -fsS -m 10 \
    -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"chat_id":"%s","text":"%s"}' "$TELEGRAM_CHAT_ID_OPS" "$TEXT")" \
    >/dev/null 2>&1 || true
fi

exit 0
