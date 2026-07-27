# config:push / config:pull — steering config backup & share via Drive — design

Date: 2026-07-28
Status: approved for planning
Scope: back up and share the git-ignored steering config (`translation/` + `conversion/`) to Google
Drive, so the auto-growing few-shot corpus is preserved and a teammate can obtain the current
config. One subsystem: two CLIs (`config:push`/`config:pull`) + a small Drive read/write helper.

## Context

The steering config — `translation/{glossary,style-guide,locale,few-shot,tm}` and
`conversion/{x,announcement,kol,pr}.md`, `conversion/checklist.*.md`, `conversion/few-shot.*.json`
(15 files) — is **git-ignored** (public repo; only `*.example.*` skeletons are tracked). The few-shot
corpuses **auto-grow** on every `translate:save --approve` / `convert:save --approve`, and `tm.json`
grows on `tm:promote`. So the single most valuable, evolving artifact in the project lives only in
one person's working tree: **no version control, no backup, no way to share it.** A prior incident
already lost these files to a `git pull` that deleted the index entries; `config:init` only writes
empty skeletons, never the real content.

The operating model (set with Kyle): **the repo working tree is the maintenance source of truth;
Drive is a transport/backup, not an edit surface.** Writer model: **single maintainer** — Kyle
pushes (backup + publish), teammates pull (restore + onboard); no multi-writer merge. That makes this
a straightforward snapshot push + latest-snapshot pull.

## Decisions

### 1. `config:push` snapshots the whole config; `config:pull` restores the latest

- **push**: bundle all steering files into one JSON manifest and upload it to a dedicated Drive
  folder as a **timestamped** file `steering-config-<stamp>.json`. Never overwrites a prior
  snapshot — history accumulates, so any past state is recoverable.
- **pull**: find the **latest** `steering-config-*.json` in the folder, download it, and write each
  file back to the local tree (overwrite).

Single-maintainer means no conflict handling: push is local→Drive, pull is Drive→local, last push
wins. A teammate's local approvals are theirs until sent to the maintainer to fold in.

### 2. Bundle = one JSON manifest of the 15 files (directory scan, `*.example.*` excluded)

```json
{ "version": 1, "pushedAt": "<ISO>",
  "files": { "translation/glossary.json": "<content>", "conversion/announcement.md": "<content>", … } }
```

The file set is discovered by scanning `translation/` and `conversion/` for regular files whose name
does **not** contain `.example.` (so the tracked skeletons and any subdirs are skipped) — no git
dependency. Keys are repo-root-relative paths (`<dir>/<filename>`); values are the file contents
(all are UTF-8 text: JSON or Markdown). One atomic file is simplest under the zod-only constraint
(no archive library), captures the auto-grown few-shot wholesale, and — since Drive is transport,
not an edit surface — needs no per-file browsability. `assembleConfigBundle`/`parseConfigBundle` are
pure and zod-validated.

### 3. Timestamped snapshots on Drive; pull takes the newest

Each push writes a new `steering-config-<stamp>.json` (stamp = ISO with `:`/`.`→`-`). `pull` lists
the config folder, filtered to `steering-config-*.json`, ordered by `createdTime desc`, and takes the
first. Keeping every snapshot is the backup value (roll back to an earlier corpus); auto-pruning old
snapshots is a non-goal (a future `config:clean` can prune).

### 4. `pull` backs up the local config before overwriting; prints a summary; `--dry-run`

`pull` is destructive to the local tree, so before writing it copies the **current** local steering
files to `output/archive/steering-<stamp>/` (mirroring the existing archive convention), then writes
the pulled files and prints `pulled N file(s) (backed up current → output/archive/steering-<stamp>/)`.
`config:pull --dry-run` prints what would change (which files, new vs modified) and writes nothing.
A pulled bundle that would create a *new* file the local tree lacks is reported too.

### 5. A small Google Drive read/write helper + auto-provisioned config folder

The existing adapters only *upload* published `.md`s (with translation-specific naming); config sync
needs (a) a raw-content upload, (b) a folder listing to find the newest snapshot, (c) a content
download — none of which exist. Add a focused `GoogleConfigDrive` adapter (injected `fetch` + the
existing `TokenSource`, `zod` for responses):

- `upload(folderId, name, content): Promise<{ id: string }>` — multipart upload of a
  `application/json` file into the folder (mirrors `GoogleDriveUploader`'s multipart).
- `latest(folderId, prefix): Promise<{ id: string; name: string } | undefined>` — `files.list`
  `q='<folderId>' in parents and name contains '<prefix>' and trashed=false`, `orderBy=createdTime
  desc`, take the first.
- `download(fileId): Promise<string>` — `GET files/{id}?alt=media`.

Folder: `GDRIVE_CONFIG_FOLDER_ID` (optional). When unset, `config:push` provisions it via the
existing `GoogleDriveProvisioner` (find-or-create `"Mantle KR Herald — Steering Config"`) and prints
`add GDRIVE_CONFIG_FOLDER_ID=<id> to your .env`. `config:pull` requires the id (nothing to pull
without it).

## Architecture

- **Domain:** `src/domain/config/bundle.ts` — `ConfigBundle` type, `assembleConfigBundle(files:
  { path: string; content: string }[], now): string`, `parseConfigBundle(json: string):
  { path: string; content: string }[]` (zod: `{ version, pushedAt, files: Record<string,string> }`).
- **Adapter:** `src/adapters/drive/GoogleConfigDrive.ts` — `upload`/`latest`/`download` (injected
  `fetch`, `TokenSource`, zod response parsing).
- **App:** `src/app/PushConfig.ts` (read the config files → `assembleConfigBundle` → `upload`) and
  `src/app/PullConfig.ts` (`latest` → `download` → `parseConfigBundle` → back up local → write files;
  `dryRun` returns the change list without writing).
- **CLI:** `src/cli/config-push.ts`, `src/cli/config-pull.ts`; `package.json` `config:push`/
  `config:pull`. Folder provisioning wired in `config-push.ts` via `GoogleDriveProvisioner`.
- **Config:** `loadGoogleConfigFolder()` (optional `GDRIVE_CONFIG_FOLDER_ID`) in `src/config.ts`.
- **A file-set port** so the use-cases stay testable without the real FS: `ConfigFileStore`
  (`list(): Promise<{ path; content }[]>`, `write(path, content)`, `backup(destDir)`), adapter
  `FsConfigFileStore` over `translation/`+`conversion/` (excludes `*.example.*`), backup to
  `output/archive/steering-<stamp>/`.
- **Reuse:** `createGoogleAuth`/`TokenSource`, `GoogleDriveProvisioner`, `paths`
  (`translationConfigDir`, `conversionConfigDir`, `archiveDir`), `registerErrorHandler`, `argValue`,
  `GoogleDriveUploader`'s multipart shape as the reference.

### Data flow

```
config:push
  FsConfigFileStore.list() → 15 {path, content}          (translation/* + conversion/*, no *.example.*)
  assembleConfigBundle(files, now) → manifest JSON
  folderId = GDRIVE_CONFIG_FOLDER_ID or provision + print
  GoogleConfigDrive.upload(folderId, "steering-config-<stamp>.json", manifest) → { id }
  → "pushed 15 file(s) → steering-config-<stamp>.json (<id>)"

config:pull [--dry-run]
  GoogleConfigDrive.latest(folderId, "steering-config-") → { id, name } | (nothing)
  GoogleConfigDrive.download(id) → manifest JSON
  parseConfigBundle → files[]
  dry-run: print new/modified per file, write nothing
  else: FsConfigFileStore.backup(output/archive/steering-<stamp>/) → write each file → summary
```

## Error handling

- `config:pull` with `GDRIVE_CONFIG_FOLDER_ID` unset, or an empty folder → a clean message
  ("no config snapshot on Drive — run config:push first"), exit 0, nothing written.
- A non-cloud / missing Google auth → the same clear `✖ set …` as the other Drive commands
  (`skipIfLocal`? — no: config sync is a maintenance action valid in any mode as long as Google auth
  exists, like `google:auth`; it is NOT storage-mode-gated. It only needs Google OAuth + the folder).
- `parseConfigBundle` on a malformed / not-a-bundle download → throws a clear "downloaded snapshot is
  not a valid config bundle" (zod error surfaced), before any local file is touched.
- The local backup (step in pull) runs **before** any overwrite; if the backup fails, pull aborts
  without writing, so a failed pull never leaves a half-overwritten local tree.
- Upload/list/download HTTP errors surface the Drive status/body (mirrors `GoogleDriveUploader`).

## Testing

- `assembleConfigBundle`/`parseConfigBundle`: round-trips a set of {path, content}; the manifest has
  `version`/`pushedAt`/`files`; `parse` rejects a missing/mistyped `files` (zod) — pinned strings.
- `GoogleConfigDrive` (injected `fetch`): `upload` posts multipart with the name + parent + JSON body;
  `latest` issues the `createdTime desc` query and returns the first (and `undefined` on empty);
  `download` GETs `?alt=media` and returns the body; a non-ok response surfaces the status.
- `PushConfig` (fake file store + fake drive): bundles exactly the store's files and uploads once with
  a `steering-config-<stamp>` name.
- `PullConfig` (fake drive + fake file store): backs up before writing; writes each bundled file;
  `--dry-run` writes nothing and reports the change list; empty-latest → nothing written + a message;
  a backup failure aborts before any write.
- `FsConfigFileStore` (temp dir): `list` returns the non-`*.example.*` files with repo-relative paths;
  `write` creates the file; `backup` copies the current set to the dest.
- All synthetic; no live Drive call in tests.

## Non-goals

- **Lark Drive target** — Google first; Lark (now unblocked) is a later `--target` add.
- **Multi-writer merge / conflict resolution** — single maintainer (decided).
- **Per-file browsing / partial (single-file) sync** — the bundle is all-or-nothing.
- **Scheduled/automatic backup** — manual `config:push`.
- **Snapshot pruning / retention** — every snapshot kept for now (future `config:clean`).
- **Selective pull** (pick an older snapshot) — pull takes the latest; rolling back to an older one
  is a manual Drive step for now.
- **Encrypting the bundle** — the config folder's Drive sharing controls access; the content is
  team-internal steering, not secrets.

## Global constraints

- Runtime deps stay **zod-only**; the adapter uses `fetch` + `zod`. No new dependency.
- `config:pull` never leaves a half-written local tree: back up first, and abort the whole pull on a
  backup or parse failure before touching any file.
- Not storage-mode-gated (`config:push`/`pull` are maintenance actions needing only Google OAuth +
  the config folder), unlike the `skipIfLocal` Sheet/Drive-publish commands.
- The set of synced files is exactly `translation/` + `conversion/` minus `*.example.*` — the tracked
  skeletons are never bundled (they are the git-committed bootstrap, not the real content).
- Public repo: no steering content, tokens, or Drive folder ids committed; tests use synthetic files.

## Open items to verify (not blockers to planning)

- After merge, `config:push` on the real tree, confirm a `steering-config-<stamp>.json` lands in the
  provisioned Drive folder; then move `translation/`+`conversion/` aside, `config:pull`, and confirm
  the 15 files are restored byte-identical and the pre-pull backup exists under `output/archive/`.
- Confirm the multipart upload sets `application/json` and the file is downloadable via `?alt=media`
  with the `drive.file` scope (the app created it, so scope suffices — same as published `.md`s).
