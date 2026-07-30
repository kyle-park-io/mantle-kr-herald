# Fork preservation: per-room copy in the lineage, operational state on Drive — Design

**Date:** 2026-07-29
**Branch:** `feat/fork-preservation` (off `main`)
**Status:** approved for planning

## Motivation

PR #80 introduced per-room overrides: editing one room's copy forks it from the group text, and the
fork lives in `output/formatted/overrides.json`. The CHANGELOG's upgrade note already tells
operators to back that file up by hand, because a fork is **not regenerable** — re-running `format`
produces the group text, not the reviewer's per-room edit.

Two distinct losses are possible, and neither leaves a trace today.

### The fork text is written down exactly once

`SaveOutletOverride` is not wired to the lineage store. PR #60 wired `SaveTranslation`,
`SaveConversion`, `SaveRendering` and `ApproveRendering`; forks arrived twenty PRs later and were
never added. So `overrides.json` holds the only copy of every forked room's text.

The sharpest case is `그룹 글로 되돌리기`. `SaveOutletOverride.ts:31-34` calls `store.remove(key)`
**without reading the existing record first** — the text is gone before anything could have recorded
it, from a single click, with no confirmation and no error. Every other destructive action on the
board either has a confirmation dialog or is recoverable.

### The file itself has no off-machine copy

The steering config gained `config:push`/`config:pull` in PR #61. The operational files under
`output/` did not. If the machine is lost, so is every fork, the send ledger, and the sync ledger —
and the failure is silent: a missing `overrides.json` reverts every forked room to the group copy
with no error on screen.

## Design

### 1. Forks enter the lineage

`LineageStage` gains **`"forked"`**. `SaveOutletOverride` takes an optional `lineage?` constructor
argument after `now`, matching PR #60's shape: absent-store means no-op.

**Amended during implementation — the best-effort rule is split, and the revert is the exception.**
As designed, all three captures were to be best-effort (failure swallowed, never changes a save's
outcome). That is right for two of them and wrong for the third, so the implemented policy is:

- **Text saved and approved stay best-effort**, exactly as PR #60. The override still exists in the
  store afterwards, so a swallowed append costs history, not text.
- **The revert does not.** A swallowed failure followed by an unconditional `store.remove` destroys
  a text that cannot be regenerated, leaving a `console.warn` on a server console nobody reads while
  the board reports success. So on the revert path a failure to record — of the lineage append *or*
  of the read that feeds it — propagates, and `remove` never runs. `apiHandlers`' PUT branch already
  turns that throw into a readable 400, so the operator sees a failure and the fork survives.

Best-effort exists so lineage cannot break a *save*. Here the "save" is a revert, which is a
convenience the operator can retry, while the text is not regenerable — so the asymmetry is the
point, not an inconsistency to be tidied away.

Holding the *read* to the same rule matters only in the transient case: the sole implementer,
`JsonOutletOverrideStore.remove`, re-reads the same file, so a persistently failing read already
failed the revert. But a read that throws once and then succeeds on `remove`'s retry would delete
the fork with no copy anywhere.

Capturing before the remove also makes the pair crash-safe in the write-ahead sense. The reverse
partial failure — capture succeeds, `remove` fails, leaving a `reverted` entry for a revert that
never happened — is tolerated: the lineage is append-only history and the fork is still in the
store, so a stray `reverted` entry beside a live override is expected, not a bug.

`variant` is `"<type>/<outletId>"` — the same shape as the existing `"type/channel"` convention, one
axis over.

Appended at **three** moments:

| moment | `content` | why |
| --- | --- | --- |
| text saved | the canonicalised fork text | the version history reviewers actually want |
| approved | the current fork text | mirrors `ApproveRendering`, so status transitions are visible |
| **reverted** | the text being discarded | the only moment a fork can vanish |

The revert case requires reading the existing override before removing it — a change to
`SaveOutletOverride`'s revert branch, which currently reads nothing. That read is the entire point:
after this, `pnpm lineage <id>` shows what was thrown away and when, and recovery is a copy-paste
rather than a restore.

The lineage is a record, not a rollback. Nothing automatically re-creates a reverted fork.

### 2. `pnpm state:push` / `pnpm state:pull`

Bundle the four non-regenerable operational files into one timestamped JSON manifest and upload it
to Drive:

- `output/formatted/overrides.json` — per-room forks
- `output/publish/deliveries.json` — the send ledger
- `output/publish/x-article.json` — the article send ledger
- `output/publish/state.json` — the Drive sync ledger

Everything else under `output/` is derivable: items re-collect, translations and variants and
renderings regenerate, lineage is an append-only view of stores that still exist.

**Amended after implementation (2026-07-30) — two of those are not derivable, and the bundle is
seven files.** The sentence above conflates "the pipeline can produce this kind of file again" with
"the pipeline reproduces this file". It holds for `renderings.json` (`format` is pure code over the
variants — the board's per-card `[포맷 다시]` runs exactly that) and for `items.json`. It does not
hold for `translations/translations.json` or `variants/variants.json`: those hold text an agent wrote
and a human then read and approved. Re-running yields *a* translation and *a* conversion — a
different one, non-deterministically, at the cost of another agent pass — and every 1차/2차 approval
resting on the old text is gone. Losing them costs human review work, which is the same class of
loss as the fork this spec was written to protect, arrived at by a different route. Both are now
tracked (`src/cli/stateFiles.ts`, listed in pipeline order). `lineage/` still stays out — it grows
without bound — but the reason it *can* stay out is now weaker than the original wording implied: it
holds the only other copy of an authored text, which is precisely why the stores must be tracked
rather than left leaning on it.

Reuse `GoogleConfigDrive` unchanged — multipart upload, `files.list` for the latest, `?alt=media`
download. Only the folder differs: `operational-state`, auto-provisioned under the same
`GDRIVE_PARENT_FOLDER_NAME` parent as `steering-config`, its id cached in `GDRIVE_STATE_FOLDER_ID`.
Snapshots never overwrite; the history is the rollback.

`GDRIVE_STATE_FOLDER_ID` goes in `.env.example` beside the other Drive folder ids, left empty like
its neighbours, with a comment saying it is auto-provisioned on first `state:push`.

### Why this is not `config:push` with more files

The two have opposite sharing models, and merging them is actively unsafe.

`config:push` is **single-maintainer distribution**: Kyle pushes the steering corpus, teammates pull
it, and pulling someone else's copy is the entire point.

`state:push` is **single-machine recovery**. Its content is a record of what this machine has
already sent. A teammate who pulled it would overwrite their own delivery ledger with Kyle's, and
rooms they had already posted to would read as never-sent — one confirmation dialog away from
re-posting months-old content into a live community room. That is the same class of incident PR
#80's legacy-migration upgrade note warns about, arrived at by a different route.

So `state:pull` is deliberately more cautious than `config:pull`:

- **Dry-run unless `--yes`**, and the dry run prints each file's current row count beside the
  snapshot's, so the operator sees what they are about to overwrite rather than a filename.
- Backs the current tree up to `output/archive/state-<stamp>/` **before** any write.
- Atomic in the same sense as `PullConfig`: parse → back up → write, aborting with zero writes if
  parsing or the backup fails.

## Testing

- Lineage capture at all three moments, including the assertion that on the **text-saved and
  approved** paths a throwing lineage store leaves the save's return value and the store's contents
  unchanged — best-effort has to be proven best-effort, not assumed.
- On the **revert** path the opposite assertion, for the reason in §1: a throwing lineage store (or
  an unreadable override store) makes the call **reject** and leaves the fork **still in the store**.
  The survival half is the one the fix rests on, so it needs a mutant that reaches it — one that
  keeps the rejection and performs the remove anyway, since a mutant that only removes the rejection
  dies on the first assertion and never proves survival.
- The revert path records the discarded text. This test fails against today's code, which is the
  point.
- Bundle round-trip: push then pull reproduces the four files byte-for-byte.
- `state:pull` refuses to write without `--yes`, and writes nothing when the backup step fails.
- Pure separation: the manifest builder and the row-count diff are pure functions, tested without
  Drive.

## Out of scope

- Automatic scheduled pushes. `state:push` is a command the operator runs, like `config:push`.
- Snapshot pruning on Drive, per-file selective restore, and multi-writer merge — all inherited
  non-goals from PR #61, unchanged here.
- A Lark target. Google Drive is where the existing config bundle lives.
- Restoring a reverted fork from the lineage automatically. The lineage makes the text readable
  again; putting it back is the reviewer's decision.
- Backing up `output/lineage/` itself. It is append-only history of stores that are themselves
  backed up, and it grows without bound.
