# Scheduler config freeze — the axis the 2026-08-07 fix left open

The 2026-08-07 outage was fixed by giving the scheduled units their own code checkout, updated only
from merged `main`. Configuration was not given the same treatment: `~/.herald/app/.env` is a
symlink into the development checkout, so the development `.env` *is* production's configuration,
read fresh at every timer fire. This makes it a snapshot taken at deploy time, and makes the change
visible when it is taken.

Written 2026-08-09. Every claim below was read out of this repo or measured on this machine at that
date, with file and line. The two behaviours that decide the design — systemd's precedence over
Node's `--env-file`, and what `ln -sfn` does with a missing target — were run, not assumed.

## The question this started from

> 내 말은 각 환경 마다 env 관리하거나 입력하는거 지금이 최선이야, 고도화할 게 있어

Four gaps came out of the survey. This spec is the first one only; the other three are named at the
bottom so they are not lost.

## The three surfaces today

| Surface | Holds | Authored by | Reaches production |
| --- | --- | --- | --- |
| `<dev>/.env` | everything the CLI reads | hand | `tsx --env-file-if-exists=.env`, every `package.json` script |
| Vercel project env | 29 names (`src/deploy/requirements.ts`) | `vercel env add` | platform, at function boot |
| `~/.herald/prod.env` | 2 lines — `DATABASE_URL`, `HERALD_DB_ENV=production` | hand, chmod 600 | `EnvironmentFile=` on all three units |

The layering between the last two is deliberate and correct. A shell-exported variable wins over
Node's `--env-file`, so `prod.env`'s two lines override the development `.env`'s local-Docker
`DATABASE_URL` without either unit touching `.env` itself. `deploy/herald-watch.service` states this
and claims it was verified; it was re-verified for this spec on Node v24.19.0:

```
$ FOO=from_systemd node --env-file-if-exists=.env -e 'console.log(process.env.FOO)'   # .env has FOO=from_dotenv
from_systemd
```

Nothing in this spec changes that mechanism.

## What is actually broken

**Everything `prod.env` does not name comes from the development checkout, live.**
`deploy/herald-deploy.sh:93` is one line:

```bash
ln -sfn "$DEV_DIR/.env" "$APP_DIR/.env"
```

`link_ignored_config` (`herald-deploy.sh:74-102`) does the same for every git-ignored file under
`translation/`, `conversion/` and `keys/`. So `TELEGRAM_CHAT_ID_COMMUNITY`, `TYPEFULLY_API_KEY`,
`X_PREMIUM`, every `GDRIVE_*`, the glossary, the style guide and the conversion prompts are, at the
moment a timer fires, whatever the development checkout says right then.

This is the same shape as the outage that produced the deploy checkout in the first place. From
`tests/deploy/workingDirectory.test.ts`'s own header: *"Until 2026-08-07 that directory was the
development checkout, so every feature branch was live in production the instant it was checked
out."* Code was isolated. Configuration was not, and it needs no checkout, no merge and no deploy —
editing a file is enough.

The failure it opens is quiet in both directions. Point `TELEGRAM_CHAT_ID_DEV` at a scratch room to
test something, and the 18:41 fire delivers production copy there. Pull a team glossary update
mid-edit, and the next tick translates against a half-written one.

### The latent bug in the same line

`ln -sfn` succeeds when its target does not exist. Measured:

```
$ ln -sfn /nonexistent/.env dangle/.env ; echo $?
0
$ node --env-file-if-exists=.env -e '...'
.env not found. Continuing without it.
```

`set -euo pipefail` cannot catch this — `ln` did not fail. The deploy reports success, and the
scheduler runs with no credentials at all, announced by one line in the journal. This is not
hypothetical: on 2026-08-09 a WSL reset removed the development `.env` from this machine, so the
first deploy after rebuilding `~/.herald` would have hit exactly this.

`ln -sfn` also never removes anything. A steering file deleted in the development checkout keeps its
link, and production keeps translating against a glossary that no longer exists.

## The change

Production configuration becomes a snapshot taken at deploy time. The invariant already true of code
becomes true of configuration: **`bash deploy/herald-deploy.sh` is the only thing that moves
production.**

| Layer | Was | Becomes |
| --- | --- | --- |
| `~/.herald/prod.env` | 2 lines, `EnvironmentFile=`, highest precedence | unchanged |
| `~/.herald/app/.env` | symlink into dev checkout | copy, written at deploy |
| `~/.herald/app/{translation,conversion,keys}/` | symlinks into dev checkout | copies, written at deploy |

A second layer makes the deliberate path visible: the deploy prints a **name-only** diff between the
previous snapshot and the current `.env`, and refuses without `--yes` when anything changed. The
first layer stops production moving without a human; the second stops a human moving it without
seeing what moved. `pnpm db:import` already establishes the preview-then-`--yes` idiom this follows.

### Accepting the cost

`herald-deploy.sh:62-67` argues for symlinks: *"a second copy is a second thing to keep in sync, and
the one that drifts is always the one nobody remembers exists."* That argument is not wrong; it no
longer applies here. Non-synchronisation is the goal — production must **not** follow development
edits. What survives is the real cost: one more file holding credentials on this machine. The copy
is written `chmod 600`. `~/.herald` is outside the repo, so neither `.gitignore` nor `.vercelignore`
is involved.

Hand-editing `~/.herald/app/.env` is overwritten by the next deploy, the same rule `git reset --hard`
already imposes on code there. That directory is a mirror, not a place work happens.

## Components

### `src/deploy/configFreeze.ts` — pure, no I/O

Same tier as `requirements.ts` and `smokeChecks.ts`: the logic worth testing, with the I/O kept out.

- `parseEnv(text): Map<string, string>` — comments, blank lines, quoted values, `KEY=` with an empty
  value. A later duplicate key wins, matching Node's own `--env-file`.
- `diffEnv(prev, next): { added: string[]; changed: string[]; removed: string[] }` — **names only.**
  Values are compared inside the function and never leave it.
- `diffFiles(prev, next): { added; changed; removed }` — steering files by name and content hash.
  Deliberately the same `{ added; changed; removed }` shape as `diffEnv`, so one formatter serves
  both: an environment variable name and a steering file path are both just names here.
- `formatFreezeDiff(label, diff): string` — `  + NAME` / `  ~ NAME` / `  - NAME` under a `label`
  heading, matching the existing `  link: …` / `  code: …` line style of `herald-deploy.sh`.
  Called once for the environment diff and once for the steering diff.

### `src/cli/deploy-freeze.ts` — I/O and the gate

Registered without `--env-file-if-exists`, alongside `auth:hash`, `config:init` and `glossary`: it
does not read environment configuration, it moves it.

- `--check` — read-only. Prints the diff. Exits `2` if anything changed and `--yes` was not passed.
  Exits `1` if `<dev>/.env` is missing, naming the remedy.
- `--apply` — writes each file to a temporary name in the destination directory, sets its mode, then
  renames. `.env` and anything under `keys/` get `chmod 600`; steering files get a flat `0644` rather
  than their source mode, since a glossary is a team document and not a secret — a mode carried over
  from the development checkout would mean a stray `chmod` on a glossary there silently decides what
  production's copy is, which is a way for configuration to move without a deploy, the exact thing
  this spec exists to close. Deletes files in the deploy checkout that are git-ignored in the
  development checkout but no longer present there.

The file list stays **derived**, never hardcoded: `git -C <dev> check-ignore` selects exactly what
`link_ignored_config` selects today, so a steering file added later is picked up with no edit here.
That was the right call in the original script and the reasoning is unchanged.

### `deploy/herald-deploy.sh`

```bash
# ── 0. Config gate — before anything destructive ──
pnpm deploy:freeze --check "$@"

# ── 1. Code: git fetch + reset --hard ──
# ── 2. Deps: pnpm install --frozen-lockfile ──

# ── 3. Config: apply the snapshot ──
pnpm deploy:freeze --apply

# ── 4. Schema: pnpm db:migrate (production) ──
```

The gate runs first because the script's own header forbids the alternative: *"a half-finished deploy
is worse than none."* Gating after the code has already moved to `origin/main` produces exactly that
state. `--apply` runs where the linking used to, after `pnpm install`, so a failed dependency install
does not leave configuration ahead of code.

## Failure handling

| Situation | Behaviour |
| --- | --- |
| `<dev>/.env` missing | Refuse, exit 1, print the remedy. Today: dangling symlink, silent credential-less run |
| No previous snapshot (first deploy) | Every name reports as added; still gated |
| Nothing changed | `config: unchanged`, proceeds without `--yes` |
| Steering file deleted in dev | Deleted in the deploy checkout. Today: stale link persists forever |
| Deploy interrupted mid-apply | Temp-file-then-rename means each file is old or new, never half-written |

## Testing

- `tests/deploy/configFreeze.test.ts` — the pure functions. The load-bearing assertion is that a
  secret-shaped value placed in both inputs never appears in `formatFreezeDiff`'s output. Plus
  parsing (comments, quotes, empty values, duplicate keys) and each of added/changed/removed.
- `tests/deploy/heraldDeploy.test.ts` — regex over the script text, the same technique
  `workingDirectory.test.ts` uses. Asserts: no `ln -sfn` for `.env`; `deploy:freeze --check` appears
  before the `git reset --hard` line; `--apply` appears after `pnpm install`.
- `tests/deploy/workingDirectory.test.ts` — **not extended, on purpose.** The property this planned
  to add is already pinned transitively and a second assertion of it would only be a second thing to
  update: `heraldDeploy.test.ts` asserts the literal `--app "$APP_DIR"` in the gate and apply lines,
  and `workingDirectory.test.ts` already pins `APP_DIR` to all three units' `WorkingDirectory=`. The
  freeze target therefore cannot drift from the units without one of those two failing.

- `tests/deploy/deployFreeze.test.ts` — the CLI against temporary directories: exit 2 when changed
  without `--yes`, exit 0 with it, exit 1 on a missing `<dev>/.env`, `chmod 600` on the written
  `.env`, and a steering file removed in dev being removed by `--apply`. Temporary directories
  rather than the real deploy script, which touches `$HOME`.

## Out of scope

Named here so they are not lost. Each needs its own spec.

1. **Deployed-credential liveness.** `deploy-check.ts:259-271` already names this and
   `2026-08-04-deploy-scripts-design.md` already deferred it: nothing can tell whether Vercel's copy
   of the Google refresh token is alive, because `createDeps` checks presence only. The 2026-08-04
   rehearsal ran an hour with `✓ Google Drive configured` while every refresh returned
   `invalid_grant`. Closing it means a liveness probe in the app.
2. **`.env` as a single point of failure.** `GDRIVE_CONFIG_FOLDER_ID`, `GDRIVE_STATE_FOLDER_ID`,
   `TWITTERAPI_IO_KEY`, `LARK_CHAT_IDS` and `GDRIVE_SHARE_EMAILS` exist in no other place — not
   Vercel, not git. The 2026-08-09 WSL reset destroyed them.
3. **A single variable registry.** Adding a variable touches `.env.example`, `docs/ko/env.md`,
   `src/deploy/requirements.ts` and the surfaces themselves. Only `requirements.ts` is machine-read,
   and it knows the Vercel surface only.
