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

# The tree this script installs INTO. Never edited by hand; `git reset --hard` below is what makes
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

# The two ARTIFACT trees, which are not the two checkouts above and do not follow from them.
# `src/paths.ts` roots every artifact at `OUTPUT_DIR`: `<repo>/output` by default, or
# `HERALD_OUTPUT_DIR` when set. The scheduled units set it to `%h/.herald/output` — deliberately
# OUTSIDE `%h/.herald/app`, so step 1's `git reset --hard` cannot wipe the scheduler's own state — so
# nothing derives the destination below from `$APP_DIR`, and step 4 needs its own pair of roots.
# Hardcoded absolutes for the same reason `DEV_DIR` is: one box, and a parameterised version would be
# a config file nobody maintains. tests/deploy/referenceCorpus.test.ts pins APP_OUTPUT_DIR equal to
# the units' own `Environment=HERALD_OUTPUT_DIR`, the way workingDirectory.test.ts pins APP_DIR to
# their `WorkingDirectory=`; if they ever drift, this script fills a directory nothing reads.
DEV_OUTPUT_DIR="$DEV_DIR/output"
APP_OUTPUT_DIR="$HOME/.herald/output"

echo "herald-deploy: $DEV_DIR (config source) → $APP_DIR (runtime)"

# ── 0. Configuration gate ─────────────────────────────────────────────────────────────────────────
# Before anything destructive. Until 2026-08-09 the deploy checkout's .env was a symlink into
# $DEV_DIR, so production's configuration was the development checkout's, read fresh at every timer
# fire — the same exposure the deploy checkout closed for code on 2026-08-07, still open on the
# config axis. It is a copy now, taken here, and this gate prints what the copy would change (names
# only, never values) and stops unless --yes says the change is intended.
#
# It runs before the `git reset --hard` below and not next to the copy in step 3, because refusing
# after the code has already moved is exactly the half-finished deploy this script's header rules
# out. Read-only: nothing on disk changes until step 3.
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
# Copies .env and the git-ignored steering configuration under translation/, conversion/ and keys/
# from the development checkout. The list is DERIVED, never hardcoded — `git check-ignore` decides,
# so a steering file added later is picked up with no edit here. The one subtraction from that is
# `translation/few-shot.json` / `conversion/few-shot.<type>.json`: git-ignored and in the steering
# tree, but `pnpm db:export` artifacts rather than configuration (the corpus is the
# `few_shot_examples` table), so freezing them shipped a dead snapshot. Step 0 already showed and
# gated the change; this is the write.
pnpm deploy:freeze --apply --dev "$DEV_DIR" --app "$APP_DIR"

# ── 4. Reference corpus — DATA, not steering configuration ────────────────────────────────────────
# The @0xMantleKR corpus `pnpm glossary:mine` cross-validates against. A separate step with its own
# output line rather than another entry in step 3's steering diff, and the distinction is not
# cosmetic: it has a different root (OUTPUT_DIR, not REPO_ROOT, so it does NOT land under $APP_DIR), a
# difference between the trees means "older" rather than "wrong" so it must not gate the deploy, and a
# file missing on the development side must not be swept from the scheduler's tree. All three are
# spelled out in the script's own header, which is also where the never-fails-the-deploy rule lives —
# a missing corpus is reported and the deploy carries on.
#
# Invoked as a sibling of THIS file rather than out of $APP_DIR: `bash deploy/herald-deploy.sh` is
# typed in the development checkout, so its helper is the development checkout's too — the same tree
# `pnpm deploy:freeze` runs from two steps above. Resolved the way herald-notify-failure.sh resolves
# its own root, so the pair still works when the script is invoked by absolute path.
bash "$(dirname "${BASH_SOURCE[0]}")/herald-copy-corpus.sh" "$DEV_OUTPUT_DIR" "$APP_OUTPUT_DIR"

# ── 5. Schema ─────────────────────────────────────────────────────────────────────────────────────
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
