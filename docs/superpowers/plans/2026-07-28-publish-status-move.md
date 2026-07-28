# Publish Status-Move Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `drive:publish` move an item's Drive doc between `review/` and `approved/` on a status change (delete the old-status doc instead of leaving a stale copy), best-effort.

**Architecture:** Task 1 adds the capabilities — an optional `DriveUploader.delete(remoteId)` (Google/Lark/Local) and `PublishStore.remove(key)`. Task 2 wires them into `PublishTranslations`: after publishing item X at status S on a drive, delete X's doc at any *other* status on that drive and remove its ledger row, wrapped best-effort. Drive docs are derived from `translations.json`, so a delete is always recoverable by re-rendering; a failed delete degrades to a warning and never fails the publish.

**Tech Stack:** ESM TypeScript, `vitest`, `zod`-only runtime dep (adds none), native `fetch`/`fs`.

## Global Constraints

- Runtime deps stay **zod-only**; native `fetch`/`fs`; no dependency.
- **Best-effort move:** a failed sibling delete warns and leaves at most one stale doc (today's behavior) — it never fails, blocks, or changes a publish's success (`uploaded`/`updated`/`failed` counts unchanged by a delete failure).
- The `approved/` doc stays 한글-only (`renderApproved`) and `review/` stays 원문+한글 (`renderReview`) — unchanged. The **sent/ archive is untouched** (not in the publish ledger, never matched).
- `DriveUploader.delete` throws on failure; the caller in `PublishTranslations` wraps it. `PublishStore.remove(key)` is a no-op if the key is absent.
- Public repo: tests use synthetic ids/paths/tokens only. Every test can fail: assert the exact delete target, the ledger rows removed vs kept, and the publish-still-succeeds behavior.

---

## File Structure

- **Modify** `src/ports/DriveUploader.ts` — add optional `delete?(remoteId): Promise<void>`.
- **Modify** `src/adapters/drive/GoogleDriveUploader.ts`, `LarkDriveUploader.ts`, `LocalFileUploader.ts` — implement `delete`.
- **Modify** `src/ports/PublishStore.ts` + `src/adapters/store/JsonPublishStore.ts` — add `remove(key)`.
- **Modify** `tests/support/publishStore.ts` (`InMemoryPublishStore`) — implement `remove`.
- **Modify** `src/app/PublishTranslations.ts` — the move.
- **Test:** extend `tests/adapters/drive/{googleDriveUploader,larkDriveUploader,localFileUploader}.test.ts`, `tests/adapters/store/jsonPublishStore.test.ts`, `tests/app/publishTranslations.test.ts`.

---

## Task 1: `DriveUploader.delete` (3 adapters) + `PublishStore.remove`

**Files:** Modify `src/ports/DriveUploader.ts`, `src/adapters/drive/{GoogleDriveUploader,LarkDriveUploader,LocalFileUploader}.ts`, `src/ports/PublishStore.ts`, `src/adapters/store/JsonPublishStore.ts`, `tests/support/publishStore.ts`; Test the three uploader test files + `jsonPublishStore.test.ts`

**Interfaces:**
- Produces: `DriveUploader.delete?(remoteId: string): Promise<void>` (throws on failure); `PublishStore.remove(key: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests.**

Add to `tests/adapters/drive/googleDriveUploader.test.ts` (reuse its `auth`, `folders`, `fakeFetch`):
```ts
  it("deletes a file by id with DELETE and a bearer token", async () => {
    const cap: { url?: string; headers?: Record<string, string> } = {};
    const fetchFn = (async (url: string, init?: RequestInit) => {
      cap.url = String(url); cap.headers = init?.headers as Record<string, string>;
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    await new GoogleDriveUploader(auth, folders, fetchFn).delete("file123");
    expect(cap.url).toBe("https://www.googleapis.com/drive/v3/files/file123");
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
  });

  it("throws on a non-ok delete", async () => {
    const badFetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(new GoogleDriveUploader(auth, folders, badFetch).delete("x")).rejects.toThrow(/404/);
  });
```

Add to `tests/adapters/drive/larkDriveUploader.test.ts` (reuse its fixtures): a `delete("tok")` calls `DELETE {base}/open-apis/drive/v1/files/tok?type=file` and returns for `{code:0}`; a `{code: 99}` response throws `/code=99/`. Assert against the file's existing fetch-stub style.

Add to `tests/adapters/drive/localFileUploader.test.ts`:
```ts
  it("deletes a written file, and treats a missing file as already gone", async () => {
    const uploader = new LocalFileUploader(root);
    const { id } = await uploader.upload({ name: "x-1.md", content: "hi", folder: "approved" });
    await uploader.delete(id);
    await expect(readFile(join(root, "approved", "x-1.md"), "utf8")).rejects.toThrow();
    await expect(uploader.delete(id)).resolves.toBeUndefined(); // second delete: ENOENT is not an error
  });
```

Add to `tests/adapters/store/jsonPublishStore.test.ts` (reuse its temp-dir + `entryKey`/`SyncEntry` setup):
```ts
  it("remove drops the entry with the given key and keeps the rest", async () => {
    const store = new JsonPublishStore(dir);
    const a: SyncEntry = { itemId: "x:1", stage: "translation", status: "translated", target: "google", fileName: "a.md", remoteId: "ra", contentHash: "h", uploadedAt: "t" };
    const b: SyncEntry = { ...a, status: "approved", fileName: "b.md", remoteId: "rb" };
    await store.record(a); await store.record(b);
    await store.remove(entryKey(a));
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toEqual(["x:1:approved:google"]);
  });
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/adapters/drive/ tests/adapters/store/jsonPublishStore.test.ts` → FAIL (`delete`/`remove` don't exist).

- [ ] **Step 3: Implement.**

`src/ports/DriveUploader.ts` — add to the interface (after `update?`):
```ts
  /** Delete an uploaded file by its remoteId. Throws on failure. Optional: an uploader that cannot
   *  delete omits it, and the caller leaves the file (with a warning) rather than failing. */
  delete?(remoteId: string): Promise<void>;
```

`src/adapters/drive/GoogleDriveUploader.ts` — add a method (reuse the file's `extractErrorDetail`):
```ts
  async delete(remoteId: string): Promise<void> {
    const token = await this.auth.getToken();
    const res = await this.fetchFn(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(remoteId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const detail = await extractErrorDetail(res);
      throw new Error(`Google Drive delete failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
  }
```

`src/adapters/drive/LarkDriveUploader.ts` — add a public `delete` (mirrors the DELETE its private `deletePrevious` already makes; reuse `extractLarkErrorDetail`):
```ts
  async delete(remoteId: string): Promise<void> {
    const token = await this.auth.getToken();
    const res = await this.fetchFn(
      `${this.baseUrl}/open-apis/drive/v1/files/${encodeURIComponent(remoteId)}?type=file`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const detail = await extractLarkErrorDetail(res);
      throw new Error(`Lark Drive delete failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code !== 0) throw new Error(`Lark Drive delete failed: code=${data.code} ${data.msg ?? ""}`.trim());
  }
```

`src/adapters/drive/LocalFileUploader.ts` — add (reuse the file's `unlink`, `resolve`, `isErrnoException`):
```ts
  async delete(remoteId: string): Promise<void> {
    await unlink(resolve(this.rootDir, remoteId)).catch((err: unknown) => {
      if (!isErrnoException(err) || err.code !== "ENOENT") throw err; // already gone is not a failure
    });
  }
```

`src/ports/PublishStore.ts` — add to the interface:
```ts
  /** Remove the entry with this key (from a status-move prune). No-op if absent. */
  remove(key: string): Promise<void>;
```

`src/adapters/store/JsonPublishStore.ts` — add (mirror of `record`):
```ts
  async remove(key: string): Promise<void> {
    const entries = await this.listEntries();
    const next = entries.filter((e) => entryKey(e) !== key);
    await writeJsonFileAtomic(this.dir, this.path, { entries: next } satisfies StateFile);
  }
```

`tests/support/publishStore.ts` — add `remove` to `InMemoryPublishStore` (mirror of its `record`, filtering by `entryKey`), so it still satisfies the widened `PublishStore` interface.

- [ ] **Step 4: Run to verify pass** — `pnpm exec vitest run tests/adapters/drive/ tests/adapters/store/jsonPublishStore.test.ts` → green (new + pre-existing). `pnpm exec tsc --noEmit` → passes (every `PublishStore` implementor — `JsonPublishStore` and `InMemoryPublishStore` — now has `remove`).

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(publish): DriveUploader.delete + PublishStore.remove"`

---

## Task 2: `PublishTranslations` moves the doc on status change

**Files:** Modify `src/app/PublishTranslations.ts`; Test extend `tests/app/publishTranslations.test.ts`

**Interfaces:**
- Consumes: `uploader.delete` + `publishStore.remove` (Task 1); `entryKey` (already imported).

- [ ] **Step 1: Write the failing tests** — add to `tests/app/publishTranslations.test.ts`. First add a delete-recording uploader near the existing fakes:
```ts
class DeletingUploader extends FakeUploader {
  public deleted: string[] = [];
  async delete(remoteId: string): Promise<void> { this.deleted.push(remoteId); }
}
```
Then the cases (reuse `tr`, `translationStore`, `InMemoryPublishStore`, `entryKey`):
```ts
  it("moves the doc: an item now approved deletes its prior review (translated) doc + ledger row", async () => {
    const g = new DeletingUploader("google");
    const store = new InMemoryPublishStore();
    await store.record({ itemId: "x:1", stage: "translation", status: "translated", target: "google", fileName: "old.md", remoteId: "google-old", contentHash: "h", uploadedAt: "t" });
    await new PublishTranslations(translationStore([tr("x:1", "approved")]), [g], store).run();
    expect(g.deleted).toEqual(["google-old"]);
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toContain("x:1:approved:google");
    expect(keys).not.toContain("x:1:translated:google");
  });

  it("moves back on un-approval: an item now translated deletes its prior approved doc", async () => {
    const g = new DeletingUploader("google");
    const store = new InMemoryPublishStore();
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", fileName: "app.md", remoteId: "google-app", contentHash: "h", uploadedAt: "t" });
    await new PublishTranslations(translationStore([tr("x:1", "translated")]), [g], store).run();
    expect(g.deleted).toEqual(["google-app"]);
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toContain("x:1:translated:google");
    expect(keys).not.toContain("x:1:approved:google");
  });

  it("does not delete when there is no other-status sibling", async () => {
    const g = new DeletingUploader("google");
    await new PublishTranslations(translationStore([tr("x:1", "approved")]), [g], new InMemoryPublishStore()).run();
    expect(g.deleted).toEqual([]);
  });

  it("a failed sibling delete warns but still publishes; the stale row is left", async () => {
    class FailDelete extends FakeUploader { async delete(): Promise<void> { throw new Error("nope"); } }
    const g = new FailDelete("google");
    const store = new InMemoryPublishStore();
    await store.record({ itemId: "x:1", stage: "translation", status: "translated", target: "google", fileName: "old.md", remoteId: "google-old", contentHash: "h", uploadedAt: "t" });
    const res = await new PublishTranslations(translationStore([tr("x:1", "approved")]), [g], store).run();
    expect(res.failed).toBe(0);
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toContain("x:1:approved:google");
    expect(keys).toContain("x:1:translated:google"); // stale row LEFT, not silently removed
  });

  it("skips the move for an uploader without delete", async () => {
    const g = new FakeUploader("google"); // no delete()
    const store = new InMemoryPublishStore();
    await store.record({ itemId: "x:1", stage: "translation", status: "translated", target: "google", fileName: "old.md", remoteId: "google-old", contentHash: "h", uploadedAt: "t" });
    const res = await new PublishTranslations(translationStore([tr("x:1", "approved")]), [g], store).run();
    expect(res.failed).toBe(0);
    expect((await store.listEntries()).map(entryKey)).toContain("x:1:translated:google");
  });
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/app/publishTranslations.test.ts` → the new cases FAIL (no move yet).

- [ ] **Step 3: Implement** — in `src/app/PublishTranslations.ts`, inside the uploader loop, immediately after `byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;` (still inside the `try`), add:
```ts
          // Move, don't copy: drop this item's doc at any OTHER status on this drive, so approval
          // moves review→approved and un-approval moves it back. Best-effort — a failed delete leaves
          // at most one stale doc (the pre-move behavior) and never fails the publish.
          if (uploader.delete) {
            const siblings = (await this.publishStore.listEntries()).filter(
              (e) => e.itemId === t.itemId && e.target === uploader.name && e.status !== t.status,
            );
            for (const sib of siblings) {
              if (!sib.remoteId) continue;
              try {
                await uploader.delete(sib.remoteId);
                await this.publishStore.remove(entryKey(sib));
              } catch (err) {
                console.warn(
                  `[publish] moved ${t.itemId} to ${folder} but could not remove its ${sib.status} doc on ${uploader.name}: ${err instanceof Error ? err.message : String(err)} — delete it by hand`,
                );
              }
            }
          }
```
(`folder` and `entryKey` are already in scope in this loop.)

- [ ] **Step 4: Run to verify pass, AND pre-existing PublishTranslations tests still pass** — `pnpm exec vitest run tests/app/publishTranslations.test.ts`. The pre-existing cases have empty ledgers (no sibling) so the move is a no-op for them and they stay green.

- [ ] **Step 5: Typecheck + full suite + commit.** `pnpm exec tsc --noEmit`; `pnpm test`; then `git add -A && git commit -m "feat(publish): move a doc between review/approved on status change"`.

---

## Self-Review

**1. Spec coverage:** Decision 1 (after publish, delete same-item other-status sibling + remove ledger row, best-effort) → Task 2 loop + the move/back/no-sibling/fail/no-delete tests. Decision 2 (`DriveUploader.delete` on Google/Lark/Local; `PublishStore.remove`) → Task 1 + its uploader/store tests. Decision 3 (symmetric, CLI+dashboard via `PublishTranslations`) → Task 2 (the move lives in the shared use-case) + the reverse-direction test. Non-goals (no trash/archive, sent/ untouched, no retroactive sweep, no renderer change) → nothing in the plan touches them.

**2. Placeholder scan:** No TBD/TODO; every code and test step is concrete.

**3. Type consistency:** `delete?(remoteId: string): Promise<void>` (Task 1 port) is called as `uploader.delete(sib.remoteId)` behind an `if (uploader.delete)` guard (Task 2). `remove(key: string)` (Task 1 port) is implemented by `JsonPublishStore` and `InMemoryPublishStore` (both updated in Task 1) and called as `publishStore.remove(entryKey(sib))` (Task 2). `entryKey`/`SyncEntry` are already imported in `PublishTranslations` and the test file. `FakeUploader`/`tr`/`translationStore`/`InMemoryPublishStore` are the existing fixtures; `DeletingUploader`/`FailDelete` extend `FakeUploader`.
