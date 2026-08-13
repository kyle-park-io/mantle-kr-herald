# Scheduled backup — the steering config and the production database

`config:push` and `state:push` are both manual, and one of them has been backing up the wrong
database. This spec puts them on a timer and fixes the aim.

Written 2026-08-13. Every claim below was read out of this repo or measured on this machine at that
date, with file and line. The two behaviours that decide the design — systemd's precedence over
Node's `--env-file`, and what a `null` `item_id` does to `unique (scope, item_id)` — were run
against the real production database, not assumed.

## The question this started from

> 정기적으로 여기의 translation, conversion 값을 클라우드로 업데이트해주는 스케쥴이 있어야하지 않을까
>
> 그리고 가능하다면 few shot도 클라우드에 백업해두는게 좋지 않나

Both were right, and the second one uncovered a bug that makes the first one worth doing twice over.

## What is actually broken

**`pnpm state:push` and `pnpm db:export`, run the ordinary way, back up the development database.**

Nothing marks this. The commands succeed, print a row count, and upload a snapshot — of the wrong
database. Measured 2026-08-13:

| Corpus | `few_shot_examples` | `translations` | `variants` |
| --- | --- | --- | --- |
| Neon (production) | **30** | 29 | 12 |
| local Docker (development) | 23 | — | — |

The 23 are what `translation/few-shot.json` and `conversion/few-shot.*.json` hold on disk, because
`db:export` wrote them from the local database. The 30 that the scheduler and the dashboard have
been growing on Neon have never been in a `state:push` snapshot.

The mechanism is one line of precedence. `EnvironmentFile=` exports into the process environment,
and the process environment beats Node's `--env-file`. Re-verified for this spec:

```
$ HERALD_PROBE=from_systemd tsx --env-file-if-exists=.env p.ts   # .env has HERALD_PROBE=from_dotenv
HERALD_PROBE = from_systemd
```

So the DSN a command opens depends on whether `~/.herald/prod.env` was loaded, **not** on which tree
it ran from:

| Caller | `DATABASE_URL` | `HERALD_DB_ENV` |
| --- | --- | --- |
| `pnpm …` in the development checkout | `127.0.0.1:5432/herald` | development |
| `pnpm …` by hand in `~/.herald/app` | `127.0.0.1:5432/herald` — the frozen `.env` holds the same value | development |
| the four scheduled units (`EnvironmentFile=%h/.herald/prod.env`) | Neon `ap-southeast-1` | production |
| Vercel dashboard | Neon, injected by the Marketplace integration | production |

`deploy/herald-creds.service:42` is the one unit without that `EnvironmentFile=`, and its header
says why: it opens no database.

`prod.env` holds exactly two keys — `DATABASE_URL` and `HERALD_DB_ENV`. Everything else a backup
needs (`GOOGLE_AUTH_MODE=oauth`, the OAuth refresh token, `GDRIVE_CONFIG_FOLDER_ID`,
`GDRIVE_STATE_FOLDER_ID`, all four set) comes from the frozen `.env` in the deploy checkout. **A new
unit that loads `prod.env` therefore needs no wiring of its own**: the database moves to production
and the Drive credentials stay where they are.

## What is not broken

The steering files are not at risk of being backed up from the wrong tree. Compared 2026-08-13, all
13 are byte-identical between the development checkout and `~/.herald/app`:

```
same  conversion/{announcement,casual,explainer,kakao_notice,kol,pr,x}.md
same  conversion/checklist.{announcement,x}.md
same  translation/{glossary.json,locale.json,style-guide.md,tm.json}
```

That is 13 files, where `docs/ko/setup/steering.md` §2 names 14. The fourteenth,
`translation/glossary-dismissed.json`, does not exist in either tree, and that is the sanctioned
state rather than a loss: `JsonGlossaryDismissalStore` documents "missing file → `[]`, because
'nothing dismissed yet' is the ordinary state of a fresh checkout." Nothing has been dismissed yet.
`isSteeringConfigFile` already accepts the name, so it joins the bundle the day it is written. Noted
only because anyone verifying a restored tree against the doc will count 13 and suspect a lost file.

`deploy/herald-deploy.sh` copies them at deploy time, so the two trees agree except in the window
between an edit and the next deploy — and `pnpm doctor`'s `Steering deploy sync` line
(`src/doctor/deploySteering.ts`) already reports exactly that window. The backup unit runs from
`~/.herald/app` like every other unit, with no `--from` flag and no change to the working-directory
invariant `tests/deploy/workingDirectory.test.ts` enforces.

## The design

### 1. One unit: `herald-backup.{service,timer}`

Same shape as the five that exist. `Type=oneshot` with two `ExecStart=` lines, so no new
`package.json` script is introduced and a failure in either one fails the unit:

```ini
WorkingDirectory=%h/.herald/app
EnvironmentFile=%h/.herald/prod.env
OnFailure=herald-notify-failure@%n.service
ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm config:push
ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm state:push
```

`config:push` first: it is the cheap one, it cannot fail on database state, and if the database is
unreachable the steering snapshot has still been taken.

**Cadence: daily at 05:47.** The minute must not collide with the existing five —
`{07,37}` convert, `17` watch, `23` creds, `41` x-reconcile, `53` translate-check — and
`tests/deploy/credsTiming.test.ts` derives those from `deploy/` and asserts the difference, so this
choice is enforced rather than remembered. `Persistent=true`, like the others, so a machine that was
off through the fire catches up rather than skipping the day.

Not installed by any committed script, same as the other five: copying into
`~/.config/systemd/user/` stays a human-supervised step, and `bash deploy/herald-deploy.sh` must
land this commit in `~/.herald/app` **before** the unit file is copied, because the unit names a
wrapper that lives in the deploy checkout.

### 2. `few_shot_examples` becomes the eighth tracked item in `state:push`

It passes the membership test in `src/cli/stateFiles.ts`'s header — "everything the database holds
that cannot be rebuilt by re-running the pipeline." A few-shot row is a copy of text that is already
tracked (`translations`, `variants`), but **which approvals became examples is not reproducible**,
and no command re-derives the corpus from the approved text. Re-running the pipeline yields no
few-shot corpus at all.

**Snapshot path: `output/few-shot/<scope>.json`**, not the `translation/few-shot.json` /
`conversion/few-shot.<type>.json` names. Those two names already mean something else — they are what
`pnpm db:export` writes for the `db:export` → `db:import` rollback path, they live in the steering
directories, and both `config:push` and `deploy:freeze` deliberately exclude them
(`src/domain/config/steering.ts:14`). Reusing the names inside a *state* snapshot would collide two
different artifacts on one string.

The restore must satisfy four properties:

**Ordinal order is content, not bookkeeping.** `PgFewShotStore.load()` is `order by ordinal`, and
that order is what `translate:prepare` / `convert:prepare` lay into the prompt. A restore that
recovers the right *set* in the wrong order silently changes what the model sees. Snapshot in
`ordinal` order; restore by replaying `add()` in that order, which regenerates `ordinal` as a
`bigserial` in the same sequence.

**`scope` must travel with the row.** One table holds eight corpora, distinguished only by
`scope` (`"translation"` | `"conversion:<type>"`). The path above carries it; the row need not
repeat it.

**Rows without `item_id` must be refused at push time.** The restore is a replay of
`PgFewShotStore.add`, which is `insert … on conflict (scope, item_id) do update`. That is idempotent
only when `item_id` is present. `item_id` is nullable, and Postgres never considers one `null` equal
to another for a unique constraint (`src/adapters/db/schema.ts:198` states this and depends on it —
it is how the port's documented "otherwise appends" behaviour is implemented). So an `itemId`-less
row **inserts a duplicate on every `state:pull`**, and a scheduled backup is precisely what turns
that from a theoretical hazard into a corpus that inflates a little at each restore.

Today no such row exists. Measured on production 2026-08-13:

| `scope` | rows | `item_id is null` |
| --- | --- | --- |
| `translation` | 19 | 0 |
| `conversion:announcement` | 5 | 0 |
| `conversion:x` | 5 | 0 |
| `conversion:kol` | 1 | 0 |
| **total** | **30** | **0** |

and both writers always supply it — `src/app/SaveTranslation.ts:79` and
`src/app/ApproveRendering.ts:76`. The only way a `null` enters is a hand-edited or legacy JSON file
through `db:import`. Refusing at push time (naming the offending scope, writing nothing) keeps the
snapshot a thing that can be restored repeatedly, which is the only property that makes a backup
worth having.

**`countRows` must recognise the shape** (`src/domain/state/snapshot.ts`), so `state:pull`'s preview
shows `current 30 → snapshot 30` for few-shot the way it does for the other seven rather than a
blank.

**Compatibility.** `state:pull`'s `unknownStatePaths` guard checks an incoming snapshot's paths
against `tracked()`. Adding a path is the safe direction — older snapshots simply lack it and
restore the seven — but the new path must be in `tracked()` so that a *newer* snapshot restored by
an older checkout fails loudly ("upgrade before restoring") rather than silently dropping the
corpus.

**Recovery order, to be documented in `docs/ko/setup/steering.md` §5 and the team runbook:**
`pnpm db:import --yes` (creates the schema) → `pnpm state:pull --yes` (fills it). Reversed, there is
no table to write into.

**Test.** A push → pull round trip against an empty database asserting count, `scope` assignment,
and `ordinal` order, plus a second `state:pull` asserting the count does not move.
`tests/cli/dbRoundTrip.test.ts` is the existing precedent for the shape.

### 3. Guards for the manual path

The timer does not fix the bug in "What is actually broken" — a human running `pnpm state:push` from
the repo still snapshots the development database, and now with more confidence, because a backup
schedule exists. Two changes:

- `state:push` and `db:export` print the database host and `HERALD_DB_ENV` they connected to, before
  doing anything. The `docs/ko/deploy.md` warning about silently attaching to the wrong database
  ends with "눈으로 호스트를 확인하기 전에는 파괴적인 명령을 돌리지 마세요" — this is what makes
  that possible for these two.
- `state:push` warns when `HERALD_DB_ENV` is `development`. A warning, not a refusal: snapshotting a
  development database is a legitimate thing to do deliberately, and `db:export`'s rollback path
  depends on it. It must simply stop being the thing that happens by accident.

### 4. `config:push` skips an unchanged bundle

`PushConfig.run` (`src/app/PushConfig.ts:12`) uploads unconditionally. Daily, that is ~365 snapshots
a year, nearly all identical, in a folder whose whole value is that "history is the rollback" —
finding the version before a bad edit becomes a binary search through duplicates.

Hash the assembled bundle, compare against the newest snapshot in the folder, skip the upload when
they match, and say so. Manual `config:push` gains the same behaviour, which is correct: pushing
twice after one edit should not produce two snapshots either.

`state:push` keeps uploading unconditionally. Its content genuinely changes most days, and it
already refuses the one case that matters — an empty snapshot from a fresh checkout landing at the
head of the folder (`src/app/PushState.ts:29`).

## Out of scope

- **Neon's own restore window.** Neon is a managed Postgres with instant restore; whether its
  retention makes an independent snapshot redundant inside that window is a real question, and it
  could not be read from this machine — it needs the Neon console. It does not block this work:
  retention covers a window, and it does not cover losing the project or the account.
- **The two corpora diverging.** Development holds 23 few-shot examples and production 30. Nothing
  here reconciles them, and nothing should — they are different databases on purpose. Named so it is
  not mistaken for something this spec fixed.
- **Backing up `keys/`.** It is empty; this deployment authenticates to Google with OAuth
  (`GOOGLE_AUTH_MODE=oauth`), and `GOOGLE_SA_KEY_FILE` is unset.
