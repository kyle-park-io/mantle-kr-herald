#!/usr/bin/env bash
# deploy/herald-deploy.sh
#
# Updates the deploy checkout the scheduled units actually run from. Run it after merging to `main`.
#
# Why this exists at all: a systemd user unit runs `pnpm <script>` out of its `WorkingDirectory`, so
# whatever is checked out there IS what production runs at the next timer fire. Until 2026-08-07
# that directory was the development checkout, which meant every feature branch went live the moment
# it was checked out — no merge, no review, no deploy step. It cost a real outage that day: a branch
# adding `translations.published_text` made the 18:41 fire of herald-x-reconcile.service query a
# column production did not have, the unit exited non-zero, and the OnFailure= Telegram hook fired.
#
# So production now runs from its own checkout, and this script is the only thing that moves it.
# tests/deploy/workingDirectory.test.ts pins APP_DIR below equal to both units' WorkingDirectory —
# if they ever drift, this script updates a directory nothing runs while the timers keep firing
# whatever was last left in the directory they do, which is a deploy that reports success and
# changes nothing.
#
# `set -e`, unlike deploy/herald-notify-failure.sh's deliberate `set -uo pipefail`: that script is a
# failure handler and must never fail, while this one is a deploy and a half-finished deploy is
# worse than none — dependencies from one commit against source from another, or a schema that was
# never migrated. Every step here must either complete or stop the script.
set -euo pipefail

# The tree this script installs INTO. Never edited by hand; step 1's hard reset below is what makes
# that safe to assume rather than hope. Spelled with $HOME to match the units' own `%h`.
APP_DIR="$HOME/.herald/app"

# The tree the git-ignored steering config lives in — glossary, style guide, locale, the conversion
# prompts, and .env. Machine-specific by design, exactly like the absolute paths in the unit files:
# this runs on one box, and a parameterised version would be a config file nobody maintains.
DEV_DIR="/home/kyle/code/mantle-kr-herald"

# Only two lines (DATABASE_URL, HERALD_DB_ENV=production), chmod 600, written by hand by Kyle. Read
# here for the migrate step at the bottom — a production connection string does not pass through an
# agent session, and this script never writes it.
PROD_ENV="$HOME/.herald/prod.env"

echo "herald-deploy: $DEV_DIR (config source) → $APP_DIR (runtime)"

# ── 0. Configuration gate ─────────────────────────────────────────────────────────────────────────
# Before anything destructive. Until 2026-08-09 the deploy checkout's .env was a symlink into
# $DEV_DIR, so production's configuration was the development checkout's, read fresh at every timer
# fire — the same exposure the deploy checkout closed for code on 2026-08-07, still open on the
# config axis. It is a copy now, taken here, and this gate prints what the copy would change (names
# only, never values) and stops unless --yes says the change is intended.
#
# It runs before step 1 hard-resets the checkout below, not next to the copy in step 3, because
# refusing after the code has already moved is exactly the half-finished deploy this script's header
# rules out. Read-only: nothing on disk changes until step 3.
pnpm deploy:freeze --check --dev "$DEV_DIR" --app "$APP_DIR" "$@"

# ── 1. Move the deploy checkout to merged main ────────────────────────────────────────────────────
# `fetch` then `reset --hard`, not `pull`: a pull can leave a merge commit or refuse on a conflict,
# and neither is a state a deploy target should ever be in. This directory is a mirror of
# origin/main, not a place work happens, so making it match exactly is the whole job.
git -C "$APP_DIR" fetch --quiet origin main
BEFORE="$(git -C "$APP_DIR" rev-parse --short HEAD)"
git -C "$APP_DIR" reset --hard --quiet origin/main
AFTER="$(git -C "$APP_DIR" rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  code: already at $AFTER"
else
  echo "  code: $BEFORE → $AFTER"
fi

# ── 2. Dependencies ───────────────────────────────────────────────────────────────────────────────
# `--frozen-lockfile` refuses rather than silently resolving a different tree than the lockfile
# describes: production must run the dependency versions that were tested, and a lockfile that no
# longer matches package.json is a merge problem to fix in the repo, not to paper over here.
echo "  deps: pnpm install --frozen-lockfile"
(cd "$APP_DIR" && pnpm install --frozen-lockfile --silent)

# ── 3. Freeze the git-ignored configuration ───────────────────────────────────────────────────────
# Copies .env and every git-ignored file under translation/, conversion/ and keys/ from the
# development checkout. The list is DERIVED, never hardcoded — `git check-ignore` decides, so a
# steering file added later is picked up with no edit here. Step 0 already showed and gated the
# change; this is the write.
pnpm deploy:freeze --apply --dev "$DEV_DIR" --app "$APP_DIR"

# ── 4. Schema ─────────────────────────────────────────────────────────────────────────────────────
# Run on every deploy, not only when someone remembers a migration is pending. `applySchema` is
# idempotent — every statement is `create table if not exists` / `add column if not exists` /
# `insert ... on conflict do nothing` — so an already-current database gets a no-op. This step is
# what would have prevented the 2026-08-07 outage in the first place: the column existed in the
# code before it existed in the database, and nothing in the path from merge to timer fire closed
# that gap.
echo "  schema: pnpm db:migrate (production)"
(
  set -a
  # shellcheck disable=SC1090
  . "$PROD_ENV"
  set +a
  cd "$APP_DIR" && pnpm db:migrate
)

echo "herald-deploy: done — the next timer fire runs $AFTER"
