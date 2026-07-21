# Lark Drive republish (`LarkDriveUploader.update`) — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** give `LarkDriveUploader` an `update()` so a `stale` translation republishes to Lark Drive
instead of failing, without leaving a duplicate in the folder

## Context

`2026-07-20-stale-republish` gave `GoogleDriveUploader` and `LocalFileUploader` an `update()` and
deliberately left Lark out, for two stated reasons: no content-replace endpoint was found, and
**Lark Drive was not configured on that install** (`LARK_DRIVE_*_FOLDER_TOKEN` were empty), so
Google-first cost nothing. That plan closed with:

> If a replace endpoint is confirmed later, implementing `update` on `LarkDriveUploader` is the only
> change needed — no caller changes.

The second reason has since expired. On 2026-07-21 the Lark Drive path was brought up end to end:
the drive scopes are approved, both folders are reachable by the app (granted by adding the bot's
group chat as a collaborator — see `docs/ko/setup/lark.md` §10-2), and
`HERALD_STORAGE_MODE=cloud pnpm drive:publish --target lark` published four translations into the
correct review/approved folders. Lark is now a live target, so its missing `update()` is a live
defect: **editing an already-published translation and republishing fails for Lark alone.**

### What the API actually offers — measured, not assumed

The first reason was inherited as an assumption from the earlier plan. It was verified directly
against the live tenant before designing:

| Attempt | Result |
| --- | --- |
| `upload_all` twice with the same `file_name` into the same folder | **Two files, two tokens** — same-name upload duplicates, it does not replace |
| `PUT /open-apis/drive/v1/files/{token}` | `HTTP 404 page not found` — no such route |
| `PATCH /open-apis/drive/v1/files/{token}` | Route exists but rejects every body shape tried (`?type=file`/`?type=doc` × `{name}`/`{content}`/`{}`) with `code 981002 params error` |
| `DELETE /open-apis/drive/v1/files/{token}?type=file` | `code=0` — works |

The official reference for `drive/v1` is behind JS rendering and a login wall, so `PATCH`'s schema
could not be read. **Guessing parameters for an undocumented endpoint is not an acceptable basis for
production code**, so `PATCH` is out of scope. The conclusion the earlier plan reached stands, now
on evidence rather than inference: Lark offers create and delete, not replace.

## Design

### Contract: `update` means *replace*, not *edit in place*

`LarkDriveUploader.update(remoteId, req)`:

1. `upload(req)` — creates the new file
2. on success, `DELETE` the file at `remoteId`
3. return the **new** `UploadResult`

`PublishTranslations` already overwrites the ledger row with whatever `update()` returns, so the new
`file_token` lands in `remoteId` with no caller change. The port (`src/ports/DriveUploader.ts`)
already declares `update?()` as optional, and `PublishTranslations`'s `!uploader.update` branch stops
firing for Lark the moment the method exists.

This makes the three uploaders deliberately non-identical, and the difference is user-visible:

| Target | Mechanism | File identity across a republish |
| --- | --- | --- |
| `google` | `PATCH` by file id | id, and therefore the share link, **preserved** |
| `local` | rewrite path, unlink the old path if the name changed | path preserved unless the name changed |
| `lark` | upload new, delete old | **`file_token` and link change every time** |

The changing token is the accepted cost of the platform having no replace endpoint. It is cheap
here: `LarkDriveUploader.upload` does not return a `url` today, so no Lark link is recorded in the
ledger or shown in the dashboard, and nothing downstream holds a Lark file reference that a new
token would break.

### Ordering: upload first, delete second

Upload-then-delete never leaves zero copies. The failure it can produce is an orphan — the new file
uploaded, the old one still there — which is recoverable by hand and is reported. Delete-then-upload
would trade that for a window with no file at all, which is worse for a folder reviewers are reading
from.

If `upload` throws, `delete` is never attempted and the whole update fails, exactly as today.

### Delete failure is a warning, not a failure

A failed delete does **not** throw. It logs one `console.warn` naming the orphaned token, the new
file, and what to do about it, then returns the new result normally.

Throwing would be actively harmful. `PublishTranslations` records the ledger row only after
`update()` returns; a throw would leave the freshly uploaded file **unrecorded**, so the next
`drive:publish` would upload yet another copy — duplicates compounding on every run, which is the
one outcome the sync ledger exists to prevent. Warning keeps the ledger pointing at the real current
file, so the folder converges to one live file plus at most one orphan the operator can delete.

A second benefit: with every anomaly handled the same way, the adapter never has to classify Lark's
delete error codes. "Already deleted by hand" and "permission denied" both produce one warning, and
neither corrupts the ledger. (`LocalFileUploader.update` classifies `ENOENT` vs. real errors because
it *does* throw; that reasoning does not carry over.)

`console.warn` from an adapter has precedent in this codebase:
`TwitterApiSourceGateway` warns on a malformed tweet rather than failing the run.

### Accepted risk: the window between delete and ledger record

`update()` deletes the old file *before* it returns; `PublishTranslations` only calls
`publishStore.record()` *after* `update()` resolves. If `record()` fails (disk full) or the process
is interrupted between the two, the ledger keeps naming the token this run just deleted. The next
run sees that row as `stale`, uploads a third copy, fails to delete the now-nonexistent old token
(a warning, per above), and records the third copy — leaving the *second* copy, the one this run
uploaded, orphaned in the folder with no warning and no ledger trace, because no code path in that
window is responsible for it.

This is accepted, not fixed, by this change. Closing it means writing the ledger row *before* the
delete runs rather than after, which requires restructuring `PublishTranslations` and the
`DriveUploader` port — splitting "replace" into an upload the caller records immediately and a
separate, independently-retriable delete step — rather than a change confined to
`LarkDriveUploader`. Google and `local` do not have this window: their `update()` is idempotent
against a stable id/path, so repeating it after a missed ledger write reproduces the same file, not
a third copy.

### Error text

The warning must be actionable on its own, without the reader consulting docs — it names the file
that could not be deleted and says that leaving it produces a duplicate. Upload errors keep the
existing `extractLarkErrorDetail` treatment so a Lark `{code, msg}` surfaces instead of a bare HTTP
status; the delete warning reuses the same helper.

## Testing

Unit tests in `tests/adapters/drive/larkDriveUploader.test.ts`, extending the existing injected-`fetch`
pattern (no network):

- `update` uploads the new content and then deletes the old token, returning the new file's id
- the delete request targets the old token and carries `?type=file`
- a delete that answers `code != 0` still returns the new result, and warns
- an upload failure throws and **no delete is attempted** (asserted on the fake's call log)

The live `drive.probe.test.ts` is not extended: it is a credentials smoke test, and an update probe
would have to publish and delete real content in the shared review folder.

## Documentation

Both Korean documents currently state that Lark cannot be updated, and both must change in the same
commit — leaving them describing a limitation that no longer exists would be worse than the
limitation:

- `docs/ko/team-runbook.md` — the `stale` paragraph explaining that Lark targets are reported as
  `✗ ... cannot update ...` with a two-option manual workaround
- `docs/ko/artifacts.md` — the sync-ledger section saying Lark has no update endpoint and must be
  handled by hand

Both should state the remaining, narrower caveat instead: Lark republishes correctly and leaves no
duplicate, but its `file_token` and link change on every republish, unlike Google's.

## Out of scope

- **`PATCH` on `drive/v1`.** Undocumented parameters; see the table above.
- **Importing translations as native Lark documents (`import_task` + docx block APIs).** That would
  buy real in-place editing, stable links, and in-Lark commenting, but changes what the artifact
  *is* (uploaded file → Lark Doc) and is a far larger change. Considered and rejected for this pass.
- **Recording a Lark `url` in the ledger.** `upload_all` does not return one. Not needed for this
  change.
