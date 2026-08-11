#!/usr/bin/env bash
# deploy/herald-copy-corpus.sh
#
# Copies the @0xMantleKR reference corpus from the development checkout's artifact tree into the
# scheduler's. Step 4 of deploy/herald-deploy.sh; not run on its own.
#
#   Usage: herald-copy-corpus.sh <dev-output-dir> <app-output-dir>
#
# ── Why this exists ───────────────────────────────────────────────────────────────────────────────
#
# `pnpm glossary:mine` (weekly, herald-translate-check.service) cross-validates every candidate
# against `$OUTPUT_DIR/x/reference/items.json` + `runs.json`. That corpus is written only by
# `pnpm collect:reference`, which nothing schedules — by design, since weekly collection would spend
# twitterapi.io budget on data that is overwhelmingly historical. So it is run by hand, in the
# DEVELOPMENT checkout, where `OUTPUT_DIR` is `<repo>/output`. The scheduler runs with
# `HERALD_OUTPUT_DIR=%h/.herald/output` and looked in a directory nobody had ever written to: on its
# first real fire the cross-validation was blind, which caps every candidate at tier B (`tierFor`,
# src/domain/translation/glossaryMining.ts) — a silent degradation that looks exactly like a quiet
# week. Kyle copied the files across by hand on 2026-08-11; this script is that, carried by the
# deploy.
#
# ── Why it is NOT `deploy:freeze`, and why that distinction is worth a separate file ─────────────
#
# `deploy:freeze` moves STEERING CONFIGURATION — .env, the glossary, the style guide, the keys. Three
# properties of it do not transfer to a corpus, and folding this into its diff would quietly break
# all three:
#
#   1. Different root. Steering files are REPO_ROOT-relative, so dev `<repo>/translation` maps to app
#      `~/.herald/app/translation` and one substitution covers every file. The corpus is
#      OUTPUT_DIR-relative, and its destination is `~/.herald/output/x/reference` — outside the deploy
#      checkout entirely, and not derivable from `$APP_DIR`.
#   2. Different meaning of a difference. A steering file that differs between the trees is a fault:
#      the scheduler is translating against a glossary nobody approved, and `deploy:freeze --check`
#      stops the deploy over it. A corpus that differs is just older — the miner grades its own
#      staleness from the run ledger it carries (REFERENCE_STALE_AFTER_DAYS = 28) and says so in the
#      review file and in the ops alert. Gating a deploy on it would be a prompt nobody can act on.
#   3. Different response to a deletion. `deploy:freeze` sweeps a deploy-side file whose development
#      counterpart is gone, because deleting a steering file is a decision. This script never deletes:
#      somebody clearing their own `output/` is housekeeping, and throwing away the scheduler's only
#      corpus over it would degrade every grade for a week.
#
# ── Never fails the deploy ────────────────────────────────────────────────────────────────────────
#
# Deliberately `set -uo pipefail` and not `set -e`, the same choice deploy/herald-notify-failure.sh
# makes: every path below reports and exits 0. A missing corpus is the ordinary state of a fresh
# machine, and an unwritable destination leaves the scheduler on the corpus it already had — neither
# is a reason to abort a deploy that has already moved the code, which herald-deploy.sh's own header
# calls worse than none. The two argument checks are the exception, exactly as in
# herald-run-logged.sh: no argument is a wiring mistake in the caller, not a runtime condition.
#
# Names only, never contents — the same discipline `src/deploy/configFreeze.ts` follows. Nothing here
# prints a line of a tweet.
#
# tests/deploy/referenceCorpus.test.ts runs this script for real against temp directories.
set -uo pipefail

DEV_OUTPUT="${1:-}"
APP_OUTPUT="${2:-}"
if [ -z "$DEV_OUTPUT" ] || [ -z "$APP_OUTPUT" ]; then
  echo "herald-copy-corpus.sh: usage: herald-copy-corpus.sh <dev-output-dir> <app-output-dir>" >&2
  exit 64   # EX_USAGE, so a wiring mistake is distinguishable from every condition absorbed below
fi

# Exactly what `pnpm collect:reference` (src/cli/collect-reference.ts) writes, and nothing else:
# `LocalJsonStore` writes items.json and state.json, `JsonCollectionRunLedger` writes runs.json.
#
# All three travel together or none of them means anything:
#   items.json  the corpus itself — without it there is no cross-validation at all.
#   runs.json   the coverage ledger `gradeCorpus` reads the corpus's VINTAGE out of. Copying items
#               alone would land the corpus in the `undated` state, which also caps every candidate
#               at tier B — the same silent failure this script exists to end, arrived at differently.
#   state.json  the collect watermark, so a `collect:reference` ever run against this root resumes
#               where the development one left off instead of re-fetching ten weeks of history.
#
# `pairs-proposed.json` and `pairs-review.md` are deliberately absent. They live in the same directory
# but are `pnpm tm:pair` REVIEW ARTIFACTS — a human reads them and `tm:promote` folds the accepted
# rows into `translation/tm.json`, which the steering freeze already carries. Nothing the scheduler
# runs reads them, and shipping them would be the same mistake `deploy:freeze` corrected on 2026-08-11
# when it stopped freezing `db:export`'s few-shot files: a dead snapshot of somebody's working copy.
CORPUS_FILES="items.json runs.json state.json"

DEV_REFERENCE="$DEV_OUTPUT/x/reference"
APP_REFERENCE="$APP_OUTPUT/x/reference"

if [ ! -d "$DEV_REFERENCE" ]; then
  echo "  corpus: none at $DEV_REFERENCE — glossary:mine will grade every candidate B (pnpm collect:reference)"
  exit 0
fi

if ! mkdir -p "$APP_REFERENCE" 2>/dev/null; then
  echo "  corpus: cannot create $APP_REFERENCE — leaving the scheduler on whatever corpus it already had" >&2
  exit 0
fi

copied=""
absent=""
failed=""
for name in $CORPUS_FILES; do
  src="$DEV_REFERENCE/$name"
  if [ ! -f "$src" ]; then
    absent="$absent $name"
    continue
  fi
  # Written to a temp name in the destination directory and renamed, for the reason `writeFrozen`
  # (src/cli/deploy-freeze.ts) does the same: a weekly fire that lands mid-copy must read either the
  # whole old corpus or the whole new one, never half a JSON document. `$$` keys the temp name to this
  # process, so two deploys cannot collide on it.
  tmp="$APP_REFERENCE/$name.deploy-$$"
  if cp "$src" "$tmp" 2>/dev/null && mv "$tmp" "$APP_REFERENCE/$name" 2>/dev/null; then
    copied="$copied $name"
  else
    rm -f "$tmp"
    failed="$failed $name"
  fi
done

# One line per outcome, and the destination is named on the line that copied something: the whole
# point of this step is that a reader of the deploy output can see the corpus arrive somewhere other
# than $APP_DIR.
if [ -n "$copied" ]; then
  echo "  corpus:$copied → $APP_REFERENCE"
else
  echo "  corpus: nothing to copy from $DEV_REFERENCE — glossary:mine will grade every candidate B"
fi
if [ -n "$absent" ]; then
  # `state.json` is legitimately absent whenever every `collect:reference` run so far passed `--since`
  # or `--limit` (`CollectAuthoredContent` only advances a watermark on an unqualified run), so this is
  # information rather than a warning. items.json or runs.json turning up here is worth a second look.
  echo "  corpus: no$absent in $DEV_REFERENCE (skipped)"
fi
if [ -n "$failed" ]; then
  echo "  corpus: FAILED to copy$failed — the scheduler keeps its previous corpus" >&2
fi

exit 0
