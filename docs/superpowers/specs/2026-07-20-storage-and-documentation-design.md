# Artifact storage + documentation set — design

**Date:** 2026-07-20
**Status:** approved
**Scope:** cross-cutting — fix where pipeline artifacts live, then document the whole system for
external (open-source) and internal (Mantle KR team) readers

## Context

The pipeline (A–G) works end to end and has been run on real content. It is now moving from "a thing
Kyle runs" to "a thing the team runs, and possibly a thing strangers run". Two gaps block that:

1. **Nobody can tell what the project does.** `README.md` is a per-module command reference that
   grew module by module; there is no document that states the pipeline's shape, its boundaries, or
   what a newcomer should do first. It also points readers at `docs/superpowers/specs/`, which is a
   development-history archive, not user documentation.
2. **Where real artifacts live was never decided.** It was inherited from whichever CLI was written
   first.

A survey of all 21 CLI entrypoints and their filesystem access produced the findings below. They are
the reason the storage work comes before the documentation work: documenting the current behaviour
would mean writing down bugs as if they were rules.

### Survey findings

- **`output/` is a bare string literal 36 times across 12 CLI files.** There is no constant, config
  field, or env var; `src/config.ts` handles credentials only. Because the paths are relative, every
  command silently depends on the process CWD being the repo root — running `pnpm collect` from a
  subdirectory creates a *second* `output/` tree instead of failing. Storage location is currently
  not controllable from code at all.
- **`output/` is git-ignored in full, overwritten in place, never archived.** It holds the entire
  human-labour product of the pipeline: `translations.json` (hand-written Korean),
  `variants.json`, `renderings.json`. No `.bak`, no versioning, no archive. A bad upsert or a disk
  loss is unrecoverable. Watermarks (`output/{x,lark}/state.json`) are likewise ignored — losing
  those causes silent re-collection gaps rather than a visible error.
- **`pending.json` is destructively overwritten.** `translate-prepare.ts:46`,
  `convert-prepare.ts:54` and `format.ts:39` clobber it with a plain `writeFile`. Running
  `translate:prepare` twice before saving strands the first batch with no recovery path.
  `convert-save.ts:25-33` already carries a commented workaround for the fallout;
  `translate-save.ts` and `format-save.ts` have none and simply throw.
- **Those three writes also bypass `writeJsonFileAtomic`.** Every store uses the atomic helper
  (`src/shared/store/jsonFile.ts:20`); these CLI-level writes do not. A crash mid-write leaves
  truncated JSON, and `readJsonFile` only tolerates `ENOENT` (`jsonFile.ts:13`), so the next run
  throws.
- **Worksheets accumulate without bound.** `output/{translations,variants,formatted}/worksheets/batch-<ISO>.md`
  gains a file per invocation and nothing ever deletes them — a grep for
  `unlink|rmdir|prune|cleanup|retention|purge` across `src/` returns zero hits. They are also the
  only human-readable record of what a batch looked like, so they are simultaneously unbounded and
  unbacked-up.
- **`output/publish/state.json` records only that something was published**, as a flat key set. It
  does not record *which* drive, *what* remote file, *what* URL, or *when*. Re-sync, change
  detection, and link recovery are all impossible.
- **`translation/few-shot.json` and `conversion/few-shot.<type>.json` are git-tracked but mutated by
  the CLI** (`--approve`) and by the dashboard's approve endpoint. Routine operation therefore
  dirties the working tree — and on open-sourcing, real approved Mantle translations would ship in
  the public repo.
- **Naming is not inferable.** `output/translations/translations.json` and
  `output/variants/variants.json` match their directory; `output/formatted/renderings.json` and
  `output/publish/state.json` do not. `state.json` means two unrelated schemas (watermark map in
  `x`/`lark`, published-key set in `publish`).

## Decisions

Settled during brainstorming; recorded here because later work depends on them.

- **Documentation is Korean-first.** The user-facing set is written in Korean now; an English
  translation is a later addition, and the folder layout reserves a place for it.
- **Local is the workspace, Drive is the record of truth.** This formalises the standing project
  principle (automation runs on each operator's local machine; results are shared via Google/Lark
  Drive). It does not introduce a new storage system.
- **Storage mode is explicit, never inferred.** Auto-detecting from which credentials happen to be
  present produces the worst possible failure: believing work is backed up to Drive while running
  local-only. An explicit value makes that impossible.
- **`output/` is centralised but not relocatable.** The request was to *fix* where things are
  stored; an override knob would un-fix it and would force docs 0/1/2 to hedge every path. The real
  defect is the CWD-dependent duplication, which centralisation solves.
- **Real steering content is not published.** The repo ships example skeletons; the actual Mantle
  glossary, style guide and few-shot corpus stay out of git.

## Part 1 — Storage

### 1.1 Storage tiers

| Tier | Location | Nature | git |
|---|---|---|---|
| Code + docs | `src/`, `docs/` | public | tracked |
| Steering **examples** | `translation/*.example.json`, `conversion/*.example.md` | public skeleton | tracked |
| Steering **actual** | real files in `translation/`, `conversion/` | team asset | **ignored** |
| Workspace | `output/` | disposable intermediate | ignored |
| **Record of truth** | Google Drive / Lark Drive | approved output, preserved | — |
| Publish log | Google Sheet `history` tab | publication + reach | — |

Moving the actual steering files out of git also ends the "routine operation dirties the working
tree" problem, since the files the CLI mutates are no longer tracked.

**Untracking does not erase history.** Ten steering files are currently tracked, and commit `8c9805b`
("seed few-shot from the first real E2E approvals") committed real approved output —
`translation/few-shot.json` (5 entries) and `conversion/few-shot.x.json` (3 entries) — alongside the
real `translation/glossary.json` and `style-guide.md`. `git rm --cached` stops *future* content from
shipping but leaves every past revision reachable in a published repo. The material is Korean
translation of Mantle's already-public tweets, so this is a disclosure-of-internal-tone question
rather than a secrets question; resolving it (accept, squash history, or publish from a fresh repo)
belongs to the open-sourcing decision, which is out of scope here. This work makes the split correct
going forward.

### 1.2 Storage mode

```bash
HERALD_STORAGE_MODE=local|cloud
```

Shipped **uncommented as `local` in `.env.example`**, so `cp .env.example .env` yields an explicit
value with zero onboarding friction. The value is visible in a file rather than assumed in someone's
head — which is what "explicit" has to mean for it to actually prevent the failure.

A missing or invalid value is a hard error naming both valid values and pointing at `pnpm doctor`.
The value is resolved **only by commands that touch pipeline artifacts** — `lark:chats`, `glossary`
and `doctor` keep working without it.

| | `local` | `cloud` |
|---|---|---|
| collect → translate → convert → format | identical | identical |
| `drive:publish`, `history:record`, `sheet:init`, `targets:list` | print *"local mode — skipped"* and exit 0 | run |
| archive | **automatic** — the only safety net | on request |
| `pnpm status` | archive state | **warns: N unsynced** |
| `pnpm doctor` | reports the active mode | reports the active mode |

Skipping exits 0, not non-zero: in `local` mode not publishing is correct behaviour, not a failure,
and a non-zero exit would break any wrapper script.

Approval does **not** trigger an automatic upload. Publishing stays a deliberate human action.

An external user starts in `local` and promotes to `cloud` later; on promotion the backlog uploads
in one pass, driven by the ledger below.

### 1.3 Sync ledger

`output/publish/state.json` is promoted from a key set to a ledger. The existing format is detected
and converted on read, so no manual migration is needed.

```jsonc
{
  "entries": [
    {
      "itemId": "x:1934…",
      "stage": "translation",          // which pipeline stage produced it
      "status": "approved",
      "target": "google",              // which cloud — one row per target
      "remoteId": "1AbC…",             // remote file id
      "url": "https://…",
      "fileName": "2026-07-20-mantle-…-x1934.md",
      "contentHash": "sha256:…",       // content as uploaded
      "uploadedAt": "2026-07-20T…Z"
    }
  ]
}
```

`contentHash` is what makes the ledger more than a receipt: comparing it against the current local
content detects **"approved, then edited, but Drive still holds the old version"**, which today is
invisible. One row per `(itemId, stage, target)` keeps Google and Lark tracked independently.

`pnpm status` reads this to report unsynced and stale entries.

### 1.4 Path centralisation

`src/paths.ts` becomes the single source of truth for artifact locations, **anchored to the repo
root rather than the CWD**, removing all 36 literals.

```ts
// src/paths.ts — single source of truth for artifact locations
export const OUTPUT_DIR = /* repo root */ + "output";
export const paths = { xItems, larkItems, translations, variants, renderings, syncLedger, … };
```

No env override. If relocation is ever wanted, it becomes a one-line change in this file.

### 1.5 Retention and durability

Concretely, "archive" means `output/archive/<YYYY-MM-DD>/`, holding superseded worksheets and
replaced `pending.json` batches. In `local` mode archiving happens automatically whenever something
would otherwise be overwritten or discarded, because there is no Drive copy to fall back on. In
`cloud` mode the same move happens only when `pnpm archive` is run, since approved content is
already preserved remotely.

- `pnpm archive` — move completed worksheets and superseded batches into today's archive folder.
- `pnpm clean` — delete what is safe to delete: archive folders older than **30 days** (override
  with `--older-than <days>`), and stranded `.tmp-*` files from interrupted atomic writes. It never
  touches a live store, and prints what it would remove unless `--yes` is passed.
- The three `pending.json` writes move to `writeJsonFileAtomic`.
- `prepare` no longer silently strands an unsaved batch: an unsaved `pending.json` is archived
  before being replaced, and `translate:save` / `format:save` gain the same already-saved fallback
  that `convert:save` has.

## Part 2 — Documentation

### 2.1 Layout

```
README.md              ← reduced: one-line intro + 5-minute start + doc map
docs/
  README.md            (3) documentation rules + full map        [English, developers]
  ko/                  ← user documentation, source of truth
    capabilities.md    (0) what this can do                      [Korean]
    quickstart.md      (1) external / open-source users          [Korean]
    team-runbook.md    (2) internal team operations              [Korean]
    artifacts.md       (4) request → artifact map                [Korean]
  en/                  ← reserved for the English translation (empty for now)
  architecture/        ← unchanged                               [English, developers]
  guides/              ← unchanged; SSOT for setup procedures    [English]
  superpowers/         ← unchanged; development-history archive
```

Audience-first with a locale folder was chosen over a locale filename suffix or a separate top-level
`handbook/`: adding a language is a folder copy, the existing three-way split of `docs/` stays
intact, and `docs/` remains the entry point a visitor to the public repo would open first.

### 2.2 Document contents

**0 · `ko/capabilities.md`** — the pipeline as a whole: collect → translate → 1st review → convert →
format → 2nd review → publish → record, the commands owning each stage, and the supported sources,
channels and stores. Critically it also states the **boundaries**: no automatic posting, translation
is performed by a local Claude agent and never the Claude API, execution is local-only per operator.
Without the "cannot" list this document degrades into marketing copy.

**1 · `ko/quickstart.md`** — external readers. Its organising claim is that **every credential is
optional**: with `HERALD_STORAGE_MODE=local`, collect/translate/convert/format all run with no API
keys at all. Covers the five-minute path (`install → cp .env.example .env → doctor → first batch`),
adapting the steering config to your own team (`*.example` → real files), and the `local → cloud`
promotion procedure. Prerequisites are a **checklist plus links** — the procedures themselves stay in
`guides/`.

**2 · `ko/team-runbook.md`** — internal readers. Our concrete assets (Lark app and operating group,
Drive folders, `GSHEET_ID`, `HERALD_STORAGE_MODE=cloud`), the weekly operating routine, and approval
criteria by reference to `translation/style-guide.md`. Includes **incident response** for the three
failure modes the survey confirmed are reachable: an unsynced backlog, a destroyed `pending.json`,
and a corrupted watermark.

**4 · `ko/artifacts.md`** — the full command × reads × writes × external-system table for all 21
commands (already produced by the survey), the storage-tier table, the sync-ledger schema, the
retention policy, and an explicit **"must not lose" vs "safe to delete"** split.

**3 · `docs/README.md`** — per-folder role, audience and language; a decision tree for where a new
document belongs; and three rules:

- **SSOT** — setup *procedures* live only in `guides/`; everywhere else links to them. Without this
  the prerequisites sections of 1 and 2 become a third and fourth copy of the same instructions.
- **Locale** — `ko/` is the source of truth, `en/` a translation; Korean is updated first.
- **Companion updates** — adding a CLI requires updating `capabilities.md`, `artifacts.md` and
  `.env.example` in the same change.

`README.md` shrinks to a hub. Its current module A–G reference moves into `capabilities.md`, and the
misdirection toward `docs/superpowers/specs/` is removed.

## Execution order

| Phase | Work | Kind |
|---|---|---|
| 1 | `src/paths.ts` centralisation (36 literals removed, anchored to repo root) | code — prerequisite for everything else |
| 2 | Storage mode + sync ledger + `translation/*.example` split | code |
| 3 | `pnpm clean` / `archive`, atomic `pending.json`, unsaved-batch protection | code |
| 4 | Four Korean documents + `docs/README.md` + README reduction | docs |

Documentation comes last so that 0/1/2/4 describe settled facts. Written first, they would document
paths, modes and schemas that phases 1–3 then change. The command-mapping survey that document 4
needs is already complete, so nothing is re-investigated.

## Testing

- **Paths** — a test asserting artifact paths resolve identically regardless of `process.cwd()`,
  which is the regression that motivated centralisation.
- **Storage mode** — missing/invalid value throws with both valid values named; `local` skips the
  cloud commands with exit 0; `cloud` runs them.
- **Sync ledger** — legacy `{published: [...]}` converts on read; one row per
  `(itemId, stage, target)`; a changed `contentHash` surfaces as stale.
- **Retention** — `clean` removes only archived/stranded files and never live stores; `archive` is
  idempotent.
- **Pending protection** — a second `prepare` before `save` preserves the first batch;
  `translate:save` and `format:save` recover an already-saved item.
- Documentation is verified by following `quickstart.md` on a clean clone in `local` mode.

## Out of scope

- Actually open-sourcing the repo (LICENSE, `private: true`, publication) — this work makes the
  content split ready, but flipping the switch is a separate decision.
- Renaming stores for naming consistency (`renderings.json`, the two meanings of `state.json`) —
  requires migrating existing local data for no functional gain. Recorded in `artifacts.md` as known
  friction.
- De-duplicating `LocalJsonStore` / `LarkLocalStore` and the two few-shot store classes.
- The English translation under `docs/en/`.
- `§8` upload, `§9b` impressions, `§10` bot wiring — unchanged roadmap items.
