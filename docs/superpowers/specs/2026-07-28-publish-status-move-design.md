# Publish moves a doc between review/ and approved/ on status change — design

Date: 2026-07-28
Status: approved for planning
Scope: make `drive:publish` treat an item's Drive doc as **one doc reflecting its current status**:
publishing item X at status S deletes the same item's doc at any *other* status (and its ledger row),
so approval **moves** the doc review/ → approved/ and un-approval moves it back — instead of today's
behavior, which leaves a stale copy in the old folder (the ledger keys by
`itemId:status:target`, so `translated` and `approved` are different keys and the old-status file is
never removed). Best-effort: a failed delete never fails the publish.

## Context

`PublishTranslations` renders each translation to `renderReview` (status ≠ approved → `review/`,
원문+한글) or `renderApproved` (status = approved → `approved/`, 한글만), keyed in the sync ledger by
`entryKey = itemId:status:target`. Because status is part of the key, approving an item (status
`translated`→`approved`) publishes a **new** `approved/` file under a new key while the old
`translated`/`review/` file and its ledger row remain — the item ends up in **both** folders, and the
`review/` copy is orphaned. Un-approval (re-saving without `--approve` sets status back to
`translated`) has the same problem in reverse.

The Drive docs are **derived views** of the `Translation` in `translations.json` (the source of
truth) — `renderReview`/`renderApproved` regenerate them on demand — so deleting a doc loses nothing;
it re-renders whenever the item is next published at that status. This makes a delete-on-move safe. A
human's dashboard edits are saved to the `Translation`, so the moved/re-rendered doc always reflects
the latest content, and the marker/원문 (review-only, via `renderReview`) never leak into the
`approved/` doc.

The **sent/ archive (#65)** is unaffected: it is written by `SendChannels`/`buildArchiver` and does
**not** record to the publish ledger, so the move logic — which only inspects publish-ledger entries
for the item — never sees or touches a `sent/` doc.

## Decisions

### 1. After publishing item X at status S on target T, remove X's doc at any other status on T

In `PublishTranslations`, immediately after recording the sync entry for `(X, S, T)`, find every
publish-ledger entry with the **same itemId and target but a different status**, delete its Drive file
via the uploader, and remove its ledger row. Translation status is binary (`translated` | `approved`),
so there is at most one such sibling, but the logic handles "any other status" generically.

- Runs per uploader, inside the existing upload loop, right after `publishStore.record(entry)`.
- **Best-effort:** the delete + ledger-removal are wrapped in try/catch; on failure, warn
  (`moved X to <folder> but could not remove its <oldStatus> doc on <target> — delete it by hand`) and
  continue — the publish still counts as succeeded (the new doc is up; at worst one stale doc remains,
  exactly today's behavior, so this never regresses).
- Skipped cleanly when the uploader has no `delete` (see Decision 2) or the sibling has no `remoteId`.

### 2. Uploaders gain an optional `delete(remoteId)`; `PublishStore` gains `remove(key)`

- `DriveUploader` port: add optional `delete?(remoteId: string): Promise<void>` (parallel to the
  optional `update?`). Throws on failure; the caller (Decision 1) wraps it best-effort.
  - `GoogleDriveUploader.delete` — `DELETE https://www.googleapis.com/drive/v3/files/{id}`, throw on
    non-2xx.
  - `LarkDriveUploader.delete` — `DELETE {base}/open-apis/drive/v1/files/{token}?type=file`, throw on
    `code !== 0` (the same call its private `deletePrevious` already makes for `update`; factor the
    shared request so both use it, or add a public `delete` alongside it — implementer's choice, no
    behavior change to `update`).
  - `LocalFileUploader.delete` — `unlink(resolve(rootDir, remoteId))`; a missing file (`ENOENT`) is
    not an error (already gone).
- `PublishStore` port: add `remove(key: string): Promise<void>`. `JsonPublishStore.remove` rewrites
  `state.json` without the entry whose `entryKey` matches (mirror of `record`, atomic write).

### 3. Symmetric + covers CLI and dashboard

Both `drive:publish` (CLI) and the dashboard's publish button run through `PublishTranslations`, so the
move applies to both. Approve (`translated`→`approved`) deletes the `review/` doc; un-approve
(`approved`→`translated`) deletes the `approved/` doc and re-renders `review/`. No separate archive is
needed (the `Translation` is the source of truth).

## Architecture

- **Port** `src/ports/DriveUploader.ts` — add optional `delete?(remoteId: string): Promise<void>`.
- **Adapters** `src/adapters/drive/{GoogleDriveUploader,LarkDriveUploader,LocalFileUploader}.ts` — each
  implements `delete`.
- **Port** `src/ports/PublishStore.ts` + **adapter** `src/adapters/store/JsonPublishStore.ts` — add
  `remove(key)`.
- **App** `src/app/PublishTranslations.ts` — after `record(entry)`, prune same-item other-status
  siblings on that uploader (best-effort delete + `remove`).
- **Reuse:** `entryKey` (for match + removal), `FolderKind`, the existing upload loop and ledger snapshot.
- **Tests:** `tests/app/publishTranslations.test.ts` (the move: an item previously published at
  `translated` and now `approved` gets its review doc deleted + ledger row removed; the reverse;
  no-sibling is a no-op; a delete failure is warned and does not fail the publish; an uploader without
  `delete` is skipped). Uploader `delete` unit tests with a stub `fetch` / temp dir. `JsonPublishStore.remove`.

### Data flow

```
drive:publish → PublishTranslations.run
  for each translation t (status S), each uploader T:
      upload/update the (X,S) doc into review|approved   (unchanged)
      publishStore.record({X, S, T, …})                   (unchanged)
      # NEW — move: drop the other-status doc for this item on this drive
      for sib in ledger where sib.itemId==X && sib.target==T && sib.status!=S:
          try: uploader.delete(sib.remoteId); publishStore.remove(entryKey(sib))
          catch: warn, continue     # best-effort; publish still succeeds
```

## Error handling / edge cases

- **No sibling** (first publish of the item, or already single-status) → nothing to delete; no-op.
- **Delete fails** (network / permission / already deleted by hand) → caught, warned; publish result
  unchanged. Lark `code !== 0` and Google non-2xx both throw → caught here. Local `ENOENT` is treated
  as success inside `delete` (already gone).
- **Uploader lacks `delete`** → the sibling is left in place with a warning (no worse than today).
- **Ledger removal but file-delete deferred** — never: the ledger row is removed only after the file
  delete resolves, so a removed row always means the file is gone (or was already gone).
- **sent/ docs** — not in the publish ledger, so never matched. **`sent` FolderKind** is irrelevant to
  the sibling search (siblings differ by *status*, and sent has no ledger entry).
- Concurrent with the existing loop: siblings are found from the ledger (which `record` just updated),
  so the just-written current entry (same status) is correctly excluded by `status != S`.

## Testing

- `PublishTranslations`: seed the ledger + a fake uploader recording delete calls. Publish an item
  whose ledger already has a `translated` row, now at `approved` → assert the uploader's `delete` was
  called with the old `remoteId`, the `X:translated:T` row is gone, and `X:approved:T` remains. Reverse
  case (approved→translated). No-sibling → `delete` not called. A `delete` that throws → publish result
  still reports the item published, with the sibling row **left** in the ledger (not silently removed).
  An uploader without `delete` → sibling untouched, no throw.
- `GoogleDriveUploader.delete` / `LarkDriveUploader.delete`: stub `fetch`, assert the right URL/method
  and that a non-ok / `code!==0` throws. `LocalFileUploader.delete`: writes then deletes a temp file;
  deleting a missing file does not throw.
- `JsonPublishStore.remove`: record two entries, remove one by key, assert only the other remains.
- All synthetic ids/paths; no real tokens; no live network.

## Non-goals

- **A trash/undo or per-doc archive** — the `Translation` is the source of truth; a deleted doc
  re-renders. `translations.json` backups are separate and already exist.
- **Touching the sent/ archive** or making it status-driven.
- **A standalone `unapprove` command** — un-approval already happens by re-saving without `--approve`;
  this feature just makes its publish clean.
- **Retroactively cleaning** stale review/ copies left by past publishes — out of scope (a one-off
  sweep can be run by hand; going forward, publishes self-clean).
- **Changing `renderReview`/`renderApproved`** or the folder mapping.

## Global constraints

- Runtime deps stay **zod-only**; native `fetch`/`fs`; no dependency.
- **Best-effort:** the move never fails, blocks, or changes the success of a publish — a delete failure
  degrades to a warning and at most one stale doc (today's behavior).
- Derived-doc safety: the `Translation` is authoritative; deleting a Drive doc is always recoverable by
  re-rendering. The `approved/` doc stays 한글-only (`renderApproved`), so review-only markers/원문
  never leak.
- Public repo: tests use synthetic ids/paths/tokens only.
- Every test can fail: assert the exact delete target, the ledger rows removed/kept, and the
  best-effort (publish-still-succeeds) behavior.
