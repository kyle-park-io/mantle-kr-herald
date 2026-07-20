# Stale Re-publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `stale` item — approved, then edited, so Drive holds an outdated copy — resolvable by re-running `pnpm drive:publish`, instead of only detectable.

**Architecture:** `DriveUploader` gains an **optional** `update(remoteId, req)`. `GoogleDriveUploader` implements it as a multipart `PATCH` against the existing file id, so the Drive file id and its `webViewLink` survive and no duplicate appears. `PublishTranslations` replaces its two-way skip with a three-way decision — create when there is no ledger row, update when the row's `contentHash` differs, skip otherwise. `LarkDriveUploader` does not implement `update`, and that surfaces as a per-item failure with an actionable message rather than a silent no-op.

**Tech Stack:** TypeScript ESM (`moduleResolution: bundler`, no `.js` extensions), `zod` as the only runtime dependency, `vitest`, `tsx` for CLIs, pnpm.

## Context

`docs/ko/team-runbook.md` currently documents stale as a **known limitation with a manual workaround** (delete the ledger row, re-publish, then delete the orphaned Drive file by hand). This plan removes that limitation for Google Drive. The runbook must be updated in the same change — leaving it describing a workaround that is no longer needed would be worse than the workaround.

Two facts that shape the design, both verified in the current code:

- **`PublishTranslations` never consults `contentHash`.** `src/app/PublishTranslations.ts` skips on `if (published.has(key)) continue;`, where the key is `(itemId, status, target)`. `isStale` is used only by `src/status/sync.ts` for reporting.
- **Both uploaders create rather than replace.** `GoogleDriveUploader` POSTs to `/upload/drive/v3/files?uploadType=multipart`; `LarkDriveUploader` POSTs to `/open-apis/drive/v1/files/upload_all`. Re-uploading without an update path would leave a second file with the same name in the folder.

**Google's update contract** (confirmed against Google's "Manage uploads" guide): `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}` with `uploadType=multipart` replaces content and metadata on the existing resource. Because the file is addressed by id, the id — and therefore `webViewLink`, and the row already written into the Sheet `history` tab — is preserved.

**Lark:** no content-replace endpoint was found for `drive/v1` files; the documented path is upload (create) and download. Lark Drive is also **not configured on this install** (`LARK_DRIVE_REVIEW_FOLDER_TOKEN` and `LARK_DRIVE_APPROVED_FOLDER_TOKEN` are both empty), so Google-first costs nothing today. If a replace endpoint is confirmed later, implementing `update` on `LarkDriveUploader` is the only change needed — no caller changes.

**Why multipart and not `uploadType=media`:** `publishFileName` (`src/domain/publish/renderers.ts:24-29`) derives the filename from `approvedAt ?? translatedAt`. Re-approving an edited translation updates `approvedAt`, so the filename can legitimately change between publishes. A content-only `media` update would leave the Drive file under its old name while the ledger recorded the new one. Multipart updates both.

## Global Constraints

- **Runtime dependencies stay `zod`-only.** No new runtime packages. Node built-ins are fine.
- **All code, identifiers, comments and in-code docs in English.** `docs/ko/*` prose stays Korean; identifiers, commands, paths and env var names inside it stay English.
- **Hexagonal layering:** `domain/` (pure) → `ports/` (interfaces) → `adapters/` (I/O) → `app/` (use-cases) → `cli/`.
- **ESM imports carry no file extension** — `import { x } from "../config"`.
- **Do not modify `src/paths.ts`'s exported keys.**
- **`main` is branch-protected.** Work on a feature branch; integrate via push + PR + CI, never a local merge.
- **`CHANGELOG.md` is hand-curated** — add under `[Unreleased]`.
- Test command: `pnpm test`. Type check: `pnpm typecheck`.
- Every task ends with a commit, Conventional Commits style.

---

## File Structure

| File | Change |
|---|---|
| `src/ports/DriveUploader.ts` | Add optional `update(remoteId, req)` |
| `src/ports/PublishStore.ts` | Remove `listPublished()` — no production caller after Task 2 |
| `src/adapters/store/JsonPublishStore.ts` | Remove `listPublished()`; migration test moves to `listEntries()` |
| `src/adapters/drive/GoogleDriveUploader.ts` | Implement `update` as multipart `PATCH` |
| `src/app/PublishTranslations.ts` | Three-way create / update / skip; `updated` count |
| `tests/adapters/drive/googleDriveUploader.test.ts` | Cover `update` |
| `tests/app/publishTranslations.test.ts` | Cover the three-way decision |
| `src/cli/publish.ts` | Report updates separately from creates |
| `docs/ko/team-runbook.md` | Replace the manual workaround with the real procedure |
| `docs/ko/artifacts.md` | `drive:publish` row + sync-ledger section |
| `CHANGELOG.md` | `### Fixed` entry |

`LarkDriveUploader` is deliberately **not** modified.

---

### Task 1: `DriveUploader.update` and the Google implementation

**Files:**
- Modify: `src/ports/DriveUploader.ts`, `src/adapters/drive/GoogleDriveUploader.ts`
- Test: `tests/adapters/drive/googleDriveUploader.test.ts`

**Interfaces:**
- Consumes: `UploadRequest`, `UploadResult` from `src/domain/publish/publishModels` (`UploadResult` already has optional `url`).
- Produces: `DriveUploader.update?(remoteId: string, req: UploadRequest): Promise<UploadResult>` — Task 2 calls this and branches on whether it is present.

- [ ] **Step 1: Write the failing tests**

This file already has a `fakeFetch(capture)` helper plus module-level `auth` and `folders` consts (`tests/adapters/drive/googleDriveUploader.test.ts:4-17`). **Reuse them** — do not introduce a second mocking style. `fakeFetch` records `url` / `headers` / `body` and always returns `{ id: "file123", name: "x-1.md", webViewLink: "https://drive.google.com/file/d/file123/view" }`, so assert request shape via `cap` and result shape against those fixed values.

Add inside the existing `describe("GoogleDriveUploader", ...)` block:

```ts
  it("updates an existing file in place with a multipart PATCH against its id", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));

    const result = await uploader.update("file123", { name: "x-1.md", content: "# updated", folder: "approved" });

    expect(cap.url).toBe(
      "https://www.googleapis.com/upload/drive/v3/files/file123?uploadType=multipart&fields=id,name,webViewLink",
    );
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
    expect(cap.headers?.["Content-Type"]).toContain("multipart/related; boundary=");
    expect(cap.body).toContain("# updated");
    expect(result).toEqual({
      id: "file123",
      name: "x-1.md",
      url: "https://drive.google.com/file/d/file123/view",
    });
  });

  it("sends the new name but never a parents field, which a metadata PATCH cannot move", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};

    await new GoogleDriveUploader(auth, folders, fakeFetch(cap))
      .update("file123", { name: "renamed.md", content: "# updated", folder: "approved" });

    expect(cap.body).toContain('"name":"renamed.md"');
    // Drive moves a file with addParents/removeParents query params; a parents field in the
    // metadata body is either rejected or silently dropped, so it must not be sent.
    expect(cap.body).not.toContain("parents");
    expect(cap.body).not.toContain("APPROVED_FOLDER");
  });

  it("percent-encodes the remote id in the URL", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};

    await new GoogleDriveUploader(auth, folders, fakeFetch(cap))
      .update("a/b", { name: "x-1.md", content: "x", folder: "approved" });

    expect(cap.url).toContain("/files/a%2Fb?");
  });

  it("surfaces the API error message when an update fails", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "File not found: file123." } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      new GoogleDriveUploader(auth, folders, failing).update("file123", {
        name: "x-1.md",
        content: "x",
        folder: "approved",
      }),
    ).rejects.toThrow(/404.*File not found/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/adapters/drive/googleDriveUploader.test.ts`
Expected: FAIL — `uploader.update is not a function`.

- [ ] **Step 3: Add the optional port method**

Replace `src/ports/DriveUploader.ts`:

```ts
import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /**
   * Replace the content of an already-uploaded file, keeping its remote id and share link.
   * Optional: a drive that cannot replace content in place simply omits this, and the caller
   * reports the item rather than creating a duplicate.
   */
  update?(remoteId: string, req: UploadRequest): Promise<UploadResult>;
  /** Stable name for idempotency keys + reporting ("google" | "lark"). */
  readonly name: string;
}
```

- [ ] **Step 4: Implement `update` on the Google adapter**

In `src/adapters/drive/GoogleDriveUploader.ts`, add the method to the class. Extract the shared response handling if it reads better, but do not change `upload`'s observable behaviour.

```ts
  /**
   * Multipart PATCH against the existing file id. Addressing the file by id is what preserves
   * webViewLink — and therefore any link already written into the Sheet history tab.
   * Metadata carries `name` only: `publishFileName` can change when approvedAt changes, but
   * parents must move via addParents/removeParents query params, never a metadata field.
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: req.name });
    const body =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      `${req.content}\r\n` +
      `--${boundary}--`;

    const url =
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(remoteId)}` +
      "?uploadType=multipart&fields=id,name,webViewLink";

    const res = await this.fetchFn(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const b = (await res.json()) as { error?: { message?: string } };
        detail = b.error?.message ?? "";
      } catch {
        // non-JSON body — status alone is the detail
      }
      throw new Error(`Google Drive update failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
    return { id: data.id ?? remoteId, name: data.name ?? req.name, url: data.webViewLink };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/adapters/drive/googleDriveUploader.test.ts`
Expected: PASS, including the pre-existing `upload` tests.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, full suite passes.

```bash
git add src/ports/DriveUploader.ts src/adapters/drive/GoogleDriveUploader.ts tests/adapters/drive/googleDriveUploader.test.ts
git commit -m "feat: add in-place update to the Drive uploader port and Google adapter"
```

---

### Task 2: Three-way publish decision

**Files:**
- Modify: `src/app/PublishTranslations.ts`
- Test: `tests/app/publishTranslations.test.ts`

**Interfaces:**
- Consumes: `DriveUploader.update?` (Task 1); `entryKey`, `contentHash`, `isStale`, `SyncEntry` from `src/domain/publish/syncLedger`; `PublishStore.listEntries()`.
- Produces: `PublishResult` gains `updated: number`. `PublishFailure` is unchanged.

**The decision table.** Get this exactly right — one row is a data-loss trap:

| Ledger row for `(itemId, status, target)` | Action |
|---|---|
| absent | **create** via `upload` |
| present, `contentHash` equals current | **skip** |
| present, `contentHash` **absent** | **skip** |
| present, `contentHash` differs, uploader has `update` | **update** via `update(remoteId, …)` |
| present, `contentHash` differs, no `update` or no `remoteId` | **failure** with an actionable message |

The third row is the trap. Rows migrated from the legacy `{published: [...]}` format have no `contentHash` — they do not know their content, which is not the same as having changed. Treating absent as "differs" would re-upload **every** pre-existing item on the first run after this change, creating a duplicate in Drive for each. This is exactly the semantics `isStale` already encodes (`src/domain/publish/syncLedger.ts`).

- [ ] **Step 1: Write the failing tests**

Read the existing file first — reuse its `tr`, `translationStore`, `FakeUploader` and `InMemoryPublishStore` fixtures. Extend `FakeUploader` with an optional update capability rather than writing a second class:

```ts
class UpdatableUploader extends FakeUploader {
  public updates: Array<{ remoteId: string; req: UploadRequest }> = [];
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    this.updates.push({ remoteId, req });
    return { id: remoteId, name: req.name, url: `https://drive.example/${remoteId}` };
  }
}
```

Then add:

```ts
it("updates in place when the content changed since it was published", async () => {
  const t = tr("x:1", "approved");
  const store = new InMemoryPublishStore();
  await store.record({
    itemId: "x:1", stage: "translation", status: "approved", target: "google",
    remoteId: "file-1", contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z",
  });
  const uploader = new UpdatableUploader("google");

  const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

  expect(res.updated).toBe(1);
  expect(res.uploaded).toBe(0);
  expect(uploader.reqs).toHaveLength(0); // never created a duplicate
  expect(uploader.updates).toHaveLength(1);
  expect(uploader.updates[0].remoteId).toBe("file-1");

  const entry = (await store.listEntries()).find((e) => e.target === "google");
  expect(entry?.contentHash).not.toBe("sha256:stale");
  expect(entry?.remoteId).toBe("file-1");
});

it("skips when the content is unchanged", async () => {
  const t = tr("x:1", "approved");
  const store = new InMemoryPublishStore();
  const uploader = new UpdatableUploader("google");
  // publish once, then run again with nothing edited
  await new PublishTranslations(translationStore([t]), [uploader], store).run();
  const second = await new PublishTranslations(translationStore([t]), [uploader], store).run();

  expect(second).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
  expect(uploader.updates).toHaveLength(0);
});

// The migration trap: a legacy row has no hash. Unknown is not changed.
it("never re-uploads a row migrated from the legacy format", async () => {
  const t = tr("x:1", "approved");
  const store = new InMemoryPublishStore();
  await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google" });
  const uploader = new UpdatableUploader("google");

  const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

  expect(res).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
  expect(uploader.reqs).toHaveLength(0);
  expect(uploader.updates).toHaveLength(0);
});

it("reports a failure when a stale item's drive cannot update in place", async () => {
  const t = tr("x:1", "approved");
  const store = new InMemoryPublishStore();
  await store.record({
    itemId: "x:1", stage: "translation", status: "approved", target: "lark",
    remoteId: "tok-1", contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z",
  });
  const uploader = new FakeUploader("lark"); // no update method

  const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

  expect(res.failed).toBe(1);
  expect(res.updated).toBe(0);
  expect(uploader.reqs).toHaveLength(0); // must NOT fall back to creating a duplicate
  expect(res.failures[0].error).toMatch(/cannot update/i);
  expect(res.failures[0].error).toMatch(/lark/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/app/publishTranslations.test.ts`
Expected: FAIL — `res.updated` is `undefined`; the update tests report `uploaded: 1`.

- [ ] **Step 3: Implement the three-way decision**

In `src/app/PublishTranslations.ts`, add `updated` to `PublishResult`, switch from `listPublished()` to `listEntries()`, and replace the inner loop body.

Two deliberate consequences, so they are not mistaken for slips:

- **`byDrive` now counts creates *and* updates** — it becomes "files written on this drive", which is what the CLI line reports it as. Splitting it per-drive-per-operation would add a nested shape for no current reader.
- **`listPublished()` becomes dead and must be removed.** `PublishTranslations` is its only production caller (`src/cli/status.ts` uses `listEntries()`), so after this change it would be port surface exercised only by its own tests. Delete it from `src/ports/PublishStore.ts` and `src/adapters/store/JsonPublishStore.ts`, and update the two test files that reference it:
  - `tests/adapters/store/jsonPublishStore.test.ts` — the legacy-migration test currently asserts through `listPublished()`. Keep the behaviour covered by asserting `(await store.listEntries()).map(entryKey)` instead; do not drop the assertion.
  - `tests/app/publishTranslations.test.ts` — `InMemoryPublishStore` drops the `listPublished` method. Keep its `keys` getter, which existing assertions use as a test helper.

```ts
export interface PublishResult {
  uploaded: number;
  updated: number;
  failed: number; // count (kept for the dashboard)
  failures: PublishFailure[]; // per-failure reason
  byDrive: Record<string, number>;
}
```

```ts
  async run(): Promise<PublishResult> {
    const entries = await this.publishStore.listEntries();
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    let uploaded = 0;
    let updated = 0;
    let failed = 0;
    const failures: PublishFailure[] = [];
    const byDrive: Record<string, number> = {};

    for (const t of await this.translationStore.loadAll()) {
      const content = t.status === "approved" ? renderApproved(t) : renderReview(t);
      const folder: FolderKind = t.status === "approved" ? "approved" : "review";
      const name = publishFileName(t);
      const hash = contentHash(content);

      for (const uploader of this.uploaders) {
        const key = entryKey({ itemId: t.itemId, status: t.status, target: uploader.name });
        const existing = byKey.get(key);

        // A migrated legacy row has no hash: unknown is not changed. Re-uploading it would
        // create a duplicate in Drive for every item published before the ledger existed.
        // `isStale` already encodes exactly this "absent hash is not evidence of change" rule —
        // reuse it here instead of re-deriving the same check inline.
        if (existing && !isStale(existing, hash)) continue;

        try {
          let result;
          if (existing) {
            if (!uploader.update || !existing.remoteId) {
              throw new Error(
                `${uploader.name} cannot update a published file in place — edit it in the drive by hand, ` +
                  `or delete this row from the sync ledger to re-publish as a new file`,
              );
            }
            result = await uploader.update(existing.remoteId, { name, content, folder });
            updated += 1;
          } else {
            result = await uploader.upload({ name, content, folder });
            uploaded += 1;
          }

          const entry: SyncEntry = {
            itemId: t.itemId,
            stage: "translation",
            status: t.status,
            target: uploader.name,
            fileName: result.name,
            remoteId: result.id,
            url: result.url,
            contentHash: hash,
            uploadedAt: this.now().toISOString(),
          };
          await this.publishStore.record(entry);
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch (err) {
          failed += 1;
          failures.push({ key, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { uploaded, updated, failed, failures, byDrive };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/app/publishTranslations.test.ts`
Expected: PASS, including the pre-existing tests. Fix any pre-existing test that asserted the old `PublishResult` shape by adding `updated` — do not weaken an assertion to make it pass.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, full suite passes. The dashboard route returns `pub.run()` as JSON, so `updated` flows through additively; confirm `pnpm typecheck:web` is still clean.

```bash
git add src/app/PublishTranslations.ts tests/app/publishTranslations.test.ts
git commit -m "feat: re-publish a stale item in place instead of skipping it"
```

---

### Task 3: Surface it in the CLI and correct the documentation

The runbook currently tells operators stale has no automated remedy. That becomes false the moment Task 2 lands, so this task is not optional polish.

**Files:**
- Modify: `src/cli/publish.ts`, `docs/ko/team-runbook.md`, `docs/ko/artifacts.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: `PublishResult.updated` (Task 2).

- [ ] **Step 1: Report updates separately in the CLI**

In `src/cli/publish.ts`, replace the summary line so an operator can tell a fresh publish from a refresh:

```ts
console.log(
  `published ${result.uploaded} new + ${result.updated} updated across ${uploaders.length} drive(s); ${result.failed} failure(s)`,
);
```

Leave the `byDrive` line, the per-failure `✖` lines and the `process.exitCode` behaviour unchanged.

- [ ] **Step 2: Rewrite the stale procedure in `docs/ko/team-runbook.md`**

Find the "미동기화가 밀렸을 때" incident procedure. It currently states that `stale` has no automated remedy and gives a manual ledger-editing workaround with a warning about the orphaned Drive file. Replace that part so it says, in Korean:

- `pnpm drive:publish` now resolves **both** `unsynced` and `stale`. A stale item is updated in place, so the Drive file keeps its id and share link and no duplicate appears.
- The CLI reports them separately (`N new + M updated`).
- **Google Drive only.** Lark Drive cannot replace content in place, so a stale item on Lark is reported as a failure naming the item, and must be handled by hand.
- Items published before the sync ledger existed carry no `contentHash`. They are never reported
  stale and never re-uploaded, because the ledger cannot know what was uploaded — and this is
  **permanent**: the row is skipped before `record()` is ever called again, so it never acquires a
  hash on its own. The only remedy, and it applies to this hashless case alone, is to delete that
  row from `output/publish/state.json` and re-publish (it uploads as a new file, this time with a
  `contentHash`), then delete the superseded copy in Drive by hand. Do not use this on a row that
  already has a `contentHash` and is merely stale — that case is handled by the automated
  update-in-place path above (Google only).

Delete the obsolete manual workaround rather than leaving it alongside the new procedure — two procedures for one situation is how an operator ends up doing the destructive one.

- [ ] **Step 3: Update `docs/ko/artifacts.md`**

Two places:

- The `pnpm drive:publish` row of the command table: it writes new **and updated** `SyncEntry` rows, and calls the Drive update endpoint as well as the create endpoint.
- The sync-ledger section: `contentHash` now drives re-publishing, not only `pnpm status` reporting. State the Google-only limitation and the no-hash rule here too, since this is the reference document the runbook cites.

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Fixed`:

```markdown
- **A stale publish can now be repaired.** `pnpm drive:publish` re-uploads an item whose content
  changed after it was published, updating the Drive file in place so its id and share link — and
  any link already recorded in the Sheet `history` tab — are preserved. Previously `pnpm status`
  could report an item as `stale` with no way to resolve it. Google Drive only; Lark Drive has no
  content-replace endpoint, so a stale item there is reported as a failure. Items published before
  the sync ledger existed carry no content hash and are never re-uploaded.
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm typecheck:web && pnpm test`
Expected: all clean.

Verify no document still claims stale is unresolvable:

```bash
grep -rn "stale" docs/ko/ CHANGELOG.md
```
Expected: every remaining mention is consistent with "resolvable via `drive:publish`, Google only, legacy rows exempt". No surviving text promising a manual ledger-editing workaround as the only path.

Verify every relative link still resolves:

```bash
for f in README.md docs/README.md docs/ko/*.md; do d=$(dirname "$f"); grep -oE '\]\([^)][^)]*\)' "$f" | sed -E 's/.*\(([^)]*)\)/\1/' | grep -v '^http' | grep -v '^#' | while read -r l; do [ -e "$d/${l%%#*}" ] || echo "BROKEN $f -> $l"; done; done
```
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/cli/publish.ts docs/ko/team-runbook.md docs/ko/artifacts.md CHANGELOG.md
git commit -m "docs: stale items are now repairable by re-publishing"
```

---

## Final verification

- [ ] `pnpm typecheck && pnpm typecheck:web && pnpm test` — all clean.
- [ ] A migrated legacy ledger (`{"published": [...]}`) plus an unchanged translation produces `uploaded 0 + updated 0` — the no-duplicate guarantee for pre-existing data. This is the single most important behaviour in this plan; verify it against the real `output/publish/state.json`, which is still in the legacy format on this install, using `--target google` and confirming the run reports zero of both **before** any live publish.
- [ ] `git status --short` clean.

## Out of scope

- Implementing `update` on `LarkDriveUploader`. No content-replace endpoint was found for Lark Drive `drive/v1`, and Lark Drive is unconfigured on this install. If one is confirmed, adding the method is the only change required — no caller changes.
- Removing the stale *review*-folder file when an item moves from `translated` to `approved`. Those are different ledger keys, so both files legitimately exist; cleaning that up is a separate decision.
- Backfilling `contentHash` for legacy rows by downloading and hashing what is currently in Drive.
- `§9b` impressions, `§8` upload, `§10` bot wiring — unchanged roadmap items.
