# Local file publishing — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** make `HERALD_STORAGE_MODE=local` actually save the publish artifact to disk, instead of
skipping publication entirely

## Context

This closes a gap that has been open since the storage work landed, and it is a **correction of a
requirement that was silently narrowed**, not a new feature.

The original ask, from the first storage conversation, was:

> 만약 이걸 쓰는 사람이 클라우드 연결이 아직 불가하면 어떻게 할 건데? 플래그로 상황을 알게 하면
> **로컬에 저장하게끔** 상황을 분리시켜야 하는 거 아니야?

At spec time "로컬에 저장" (save locally) was narrowed to "skip publishing", and the change was
never flagged. `2026-07-20-storage-and-documentation-design.md` §1.2 therefore shipped as
*`drive:publish` → print "local mode — skipped" and exit 0*, and the implementation, tests, and
documentation all followed that narrowed definition faithfully. Nobody caught it until the question
"업로드에서 local이면 파일로 저장되는 거 아니야?" was asked on 2026-07-21.

### The actual gap

In `local` mode the human-readable publish artifact **never exists anywhere**.

`output/translations/translations.json` holds the data, but the `<date>-<slug>-<id>.md` review
document — source and Korean side by side, produced by `renderReview` / `renderApproved` in
`src/domain/publish/renderers.ts` — is rendered only on the path to Drive. A user without a Google
account has no way to export a readable document. That directly contradicts the claim that the
pipeline "works without cloud", which is a claim the project makes in `.env.example`,
`docs/ko/quickstart.md`, and `docs/ko/artifacts.md`, and which matters for open-sourcing.

Framing to keep, from Kyle: **로컬을 먼저 완성하고 그 다음 cloud를 본다** — local is the base case,
not a degraded fallback.

## Scope

**In scope:** `drive:publish` (CLI) and the dashboard's publish action.

**Out of scope, deliberately** — the other four CLIs that `skipIfLocal()` currently gates keep
skipping:

- `targets:list` — `LoadTargets` has exactly one caller (`src/cli/targets-list.ts`). `collect.ts:9`
  takes its handle from `process.argv[2] ?? "Mantle_Official"`, not from the Sheet. Targets are not
  on the pipeline path at all; a local equivalent would have no consumer.
- `history:record` — the Sheet `history` tab's columns A–G duplicate what
  `output/publish/state.json` already records (itemId, status, target, fileName, url, uploadedAt).
  A second local record would mean the same fact stored twice with no rule for which wins. The tab
  exists for §9b impressions (columns H–I), which come from cloud APIs and cannot be filled in local
  mode anyway. Revisit with §9b, not now.
- `drive:init` / `sheet:init` — remote provisioning. The local equivalent is `mkdir -p`, which the
  uploader does itself on first write; it does not warrant a command.

## Design

### 1. `LocalFileUploader`

A new adapter at `src/adapters/drive/LocalFileUploader.ts`. The directory groups implementations of
the `DriveUploader` **port** (`GoogleDriveUploader`, `LarkDriveUploader`), not "cloud drives", so a
local filesystem implementation belongs beside them.

```ts
export class LocalFileUploader implements DriveUploader {
  readonly name = "local";
  constructor(private readonly rootDir: string) {}
  async upload(req: UploadRequest): Promise<UploadResult>;
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult>;
}
```

Because `DriveUploader` is already a port and `PublishTranslations` takes `uploaders:
DriveUploader[]`, treating the filesystem as one more drive reuses the renderers,
`PublishTranslations`, the sync ledger, `isStale`, failure isolation, the `N new + M updated`
reporting, and the dashboard's counters **unchanged**. The alternatives were rejected:

- *A separate `ExportTranslations` use-case + `pnpm export`* — would not share the ledger, so
  `pnpm status` could not report what is unsynced or stale locally, and the whole stale-republish
  path would have to be rebuilt. It also makes "publish" a different command depending on mode,
  when the requirement was that publishing work in local mode.
- *Writing files inline in `publish.ts` when mode is local* — puts domain logic in a CLI, and the
  dashboard's `POST /api/publish` goes through `serve.ts`, so the same logic would have to be
  written twice and would drift.

**`rootDir` is a constructor parameter** so tests can inject a temp directory.

**`id` is a path relative to `rootDir`** — e.g. `approved/2026-07-21-foo-x-123.md`. Absolute paths
would bake `/home/<user>/...` into the ledger and break the moment the repo is moved; a relative
path also keeps the adapter free of any `REPO_ROOT` dependency and reads clearly in the ledger.

**`url` is left `undefined`.** A `file://` URL is tempting, but the dashboard is served over
`http://localhost:5757` and browsers block `file://` navigation from an http page. A link that
cannot be clicked is worse than no link. The CLI prints the paths instead.

#### `update()` must move, not merely overwrite

This is the subtle part, and the reason a naive overwrite is wrong.

`SaveTranslation.ts:29` writes a **fresh** `approvedAt` timestamp on every approval
(`approvedAt: input.approve ? timestamp : undefined`). `publishFileName()` derives the filename's
date prefix from `(approvedAt ?? translatedAt).slice(0, 10)`. So **editing an approved translation
and re-approving it on a later day changes the filename.**

Google survives this: `GoogleDriveUploader.update()` PATCHes by `remoteId` (the file id) and carries
`name` in the metadata, so the same file is renamed in place — one file, and `webViewLink` (and any
link already written into the Sheet `history` tab) survives.

A local "just overwrite" would write the new path and **leave the old file behind**: two documents
with identical content and different dates, with nothing on disk saying which is current.

The contract is therefore:

```
new = rootDir/<folder>/<name>
writeTextFileAtomic(new)                                     # mkdir -p included
if (resolve(rootDir/remoteId) !== resolve(new)) unlink(old)  # ENOENT ignored
return { id: <new, relative to rootDir>, name: req.name }    # url omitted
```

`upload()` returns the same shape. Returning the **new** relative path is what lets
`PublishTranslations` write it back into the ledger's `remoteId`, so the next re-publish knows which
file to move.

Ignoring `ENOENT` on the unlink is deliberate: the user may have moved or deleted the file by hand,
and that is not a failure. Because the write happens first, a hand-deleted artifact is **restored**
by the next publish — a case where Drive would fail with a 404 and local self-heals.

#### Atomic writes

`writeJsonFileAtomic` (`src/shared/store/jsonFile.ts:20`) is JSON-specific — it calls
`JSON.stringify` internally. Extract `writeTextFileAtomic(dir, path, text)` and have
`writeJsonFileAtomic` delegate to it.

This keeps markdown on the same `.tmp-<pid>-<ms>-<uuid>` naming convention, which matters because
`isStrandedTempFile` (`src/storage/retention.ts:22`) already matches exactly that pattern — so
`pnpm clean` keeps sweeping the debris of an interrupted write with **no new rule**.

### 2. File layout

One line added to `src/paths.ts`:

```ts
publishLocalDir: join(OUTPUT_DIR, "publish", "local"),
```

```
output/publish/
├── state.json              # sync ledger — google / lark / local rows coexist
└── local/
    ├── review/             # status=translated → source + Korean side by side
    └── approved/           # status=approved → Korean only
```

`review/` and `approved/` are derived by the adapter from `FolderKind`. Where Google and Lark are
injected with folder ids, local uses subdirectory names, so **no new env var is needed**.

**Why inside `output/` rather than a new top-level directory:**

1. `src/paths.ts:12` declares `OUTPUT_DIR` as "Root of all pipeline artifacts. Fixed by design". A
   second artifact root breaks that single source of truth.
2. **The repository is public.** `.gitignore` already ignores `output/` wholesale. A new top-level
   directory would need its own ignore rule, and forgetting it would commit translated team content
   to a public repo.

**Verified safe from retention:** `clean.ts`'s `sweepTemp()` does walk all of `output/`
recursively, but only adds paths matching `isStrandedTempFile()` — the regex
`/\.tmp-\d+-\d+-[0-9a-f-]+$/`. Published `.md` files never match. `pnpm archive` only sweeps the
three worksheet directories named explicitly in `archive.ts`. The 30-day expiry applies to
`output/archive/<date>/` day-folders only.

### 3. Mode and target wiring

#### `--target` becomes a list

Today: `argValue("--target") ?? "google"` compared against `"google" | "lark" | "both"`. Adding a
third target makes `both` ambiguous. Parse with the existing `parseList` (`src/cli/args.ts:8`) so
`--target google,local` works, and **keep `both` as an alias for `google,lark`** so existing usage
and `docs/ko/setup/README.md:20` do not break.

Valid values come from a single `ALL_TARGETS = ["google", "lark", "local"] as const`, and **usage
strings and error messages are interpolated from it**. PR #33 is the precedent: three CLIs still
printed a hardcoded `<x|kol|pr>` after `ConversionType` gained a member, because string literals are
invisible to the compiler.

#### Defaults and refusals

| | default `--target` | `local` requested | `google` / `lark` requested |
|---|---|---|---|
| `local` mode | `local` | ok | **error** |
| `cloud` mode | `google` (unchanged) | ok | ok |

`local` is a target that is always available, not a mode-only branch — so a cloud operator can run
`--target google,local` and keep an offline copy.

Requesting a cloud target in local mode **must fail loudly rather than skip**. The credentials are
absent, so it would fail regardless; hiding that behind exit 0 is precisely the failure this whole
change is correcting.

`skipIfLocal("drive:publish")` is **removed** from `src/cli/publish.ts`. The other four call sites
stay.

#### One composition point

`publish.ts:21-30` and `serve.ts`'s `uploadersFor()` already contain near-identical uploader
construction. Adding a local branch to each would make two copies of it. Extract
`createUploaders(targets, mode)` into `src/cli/uploaders.ts` and have both call it. This removes
duplication that predates this change.

`assertCloudMode(loadStorageMode(), "publishing")` disappears from `serve.ts`; the dashboard can
publish in local mode.

#### Dashboard

`web/src/components/PublishBar.tsx:5` starts at `useState("google")` and hardcodes a
`google | lark | both` `<select>`. The frontend does not know the storage mode.

Add `GET /api/config` returning `{ storageMode }`; `PublishBar` uses it to choose its default and
its options (local mode → `local`; cloud mode → the cloud targets plus `local`).

This is **not optional polish**. Removing the server-side gate without fixing the frontend leaves a
button that is enabled and fails on every first click in local mode, with a message about missing
Google credentials that makes no sense to a local user — strictly worse than today's coherent
refusal. It also matters for audience: `docs/ko/review.md` was written for reviewers who never open
a terminal, and §7 second review is dashboard-only. Those users cannot run `pnpm drive:publish`.

## Claims to invert

Listed exhaustively and on purpose: narrowing intent silently is what went wrong last time, and the
documentation edits outnumber the code edits.

| Location | Current claim | Change |
|---|---|---|
| `src/status/sync.ts:47` | local prints `(local mode — publishing disabled)` and suppresses `⚠` | Publishing happens, so warn on unsynced/stale **exactly as in cloud mode**. Delete the special case; `mode` is then read nowhere else in `formatSyncSummary`, so drop the parameter and the `tryLoadStorageMode()` argument at `src/cli/status.ts:38` with it (`tryLoadStorageMode` itself stays — `doctor.ts:30` uses it) |
| `docs/ko/artifacts.md` §1 table | `output/` = "폐기 가능한 중간 산출물"; record of truth = Drive | In local mode `output/` **is** the record of truth. Split the row by mode |
| `docs/ko/artifacts.md` §2 table | five CLIs skip in local mode | **Four.** Replace the `drive:publish` row with its local-save behaviour |
| `docs/ko/artifacts.md` §2 promotion steps | local backlog uploads in one run | Still true; add that the ledger now already holds `local` rows, and that `google` rows are separate keys so promotion uploads normally |
| `docs/ko/artifacts.md` §3 command table | `drive:publish` row | Add the local output paths |
| `.env.example` lines 20–39 | local = "the whole pipeline runs" but publishing is skipped | local = publishing writes to `output/publish/local/` |
| `.env.example` line 35 | "run drive:publish, see 'skipped', exit 0" | The never-inferred rationale still holds but needs rewording: the risk is now publishing to disk while believing it reached Drive |
| `.env.example` line 69 | section 3 commands "skip with a message and exit 0" | True for the four remaining commands; `drive:publish` no longer among them |
| `docs/ko/quickstart.md:10, 40, 89-105` | §5 promotion narrative assumes nothing was ever published | Ledger has `local` rows before promotion |
| `docs/ko/capabilities.md:39, 70, 98` | D described as Drive upload only | Add local publishing |
| `docs/ko/team-runbook.md:25` | local mode is "개인 실습용" because nothing persists | Local mode persists a real artifact; keep the point that Drive is the team's record of truth |
| `docs/ko/team-runbook.md:78-110` | `unsynced`/`stale` remedies assume Drive | Apply to local rows too |
| `docs/ko/review.md:87` | `발행 ⬆` uploads to the shared drive | Drive **or** a local folder, depending on mode |
| `docs/ko/setup/README.md:17-20` | `--target google\|lark\|both` | Add `local` and the comma-list form |

**`pnpm doctor` is left alone.** Downgrading cloud credential checks to `warn` in local mode remains
correct. A "is `output/publish/local` writable" check is deliberately **not** added: a write failure
surfaces at publish time with a real reason, doctor already has many checks, and the added value is
speculative.

## Testing

- **`LocalFileUploader` unit tests** (temp directory injected): places files by `FolderKind`;
  re-publishing under the same name overwrites; **re-publishing under a changed name deletes the old
  file**; a missing old file does not fail; an interrupted write leaves debris that
  `isStrandedTempFile` matches.
- **Regression invariant, the important one:** approve → publish → edit → re-approve (date changes)
  → publish again ⇒ **exactly one file on disk for that ledger row**. This pins the scenario that
  motivated the `update()` contract.
- **`createUploaders`:** per-mode defaults, local mode refuses `google`, `both` alias resolves to
  `google,lark`, unknown target errors and names the valid ones.
- **`formatSyncSummary`:** after the special case is removed, local warns identically to cloud.
- **`tests/app/publishTranslations.test.ts` must pass untouched** — only the adapter list changes.
  Any edit needed there is a signal the use-case was not actually reused.

## Notes

- The **hashless legacy ledger row trap** documented in `team-runbook.md` does not apply to local
  rows. Every `local` row is created by this change, so all of them carry a `contentHash` from the
  start; `isStale` never sees the "unknown is not changed" case.
- A `translated → approved` transition produces a **different** ledger key, so the `review/` copy
  remains and a new file appears under `approved/`. This already happens with Drive; local matches
  it rather than inventing different behaviour.
- Renaming the `DriveUploader` port to something mode-neutral (`PublishTarget`) was considered and
  **rejected for this change** — it touches every call site and would obscure the diff that matters.
