# Lark Drive republish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `LarkDriveUploader` an `update()` so republishing an edited translation to Lark Drive replaces the file instead of failing, leaving exactly one file in the folder.

**Architecture:** Lark's `drive/v1` has no content-replace endpoint, so `update()` means *replace*: `upload()` the new file, then `DELETE` the old `file_token`. Upload runs first so a failure never leaves the folder empty. A failed delete warns and returns normally rather than throwing, because `PublishTranslations` writes the ledger row only on a successful return — throwing would leave the new file unrecorded and upload another copy next run.

**Tech Stack:** TypeScript (ESM, `tsx`), Vitest, Lark Open API `drive/v1`. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-07-21-lark-drive-update-design.md`

## Global Constraints

- **Runtime dependencies stay `zod`-only.** No new runtime packages. Node built-ins are fine.
- **All code, identifiers, comments and in-code docs in English.** `docs/ko/*` prose stays Korean; identifiers, commands, paths and env var names inside it stay English.
- **Hexagonal layering:** `domain/` (pure) → `ports/` (interfaces) → `adapters/` (I/O) → `app/` (use-cases) → `cli/`. This change touches `adapters/` only — no port, use-case or CLI changes.
- **No caller changes.** `src/ports/DriveUploader.ts` already declares `update?()`; `src/app/PublishTranslations.ts` already calls it when present. Do not modify either.
- **`PATCH /drive/v1/files/{token}` is out of scope** — the route exists but rejects every body shape tried with `code 981002 params error`, and its schema is not published.

---

## File Structure

| File | Responsibility | Action |
| --- | --- | --- |
| `src/adapters/drive/LarkDriveUploader.ts` | Lark Drive I/O: upload, and now replace-by-delete | Modify |
| `tests/adapters/drive/larkDriveUploader.test.ts` | Unit tests with an injected `fetch` | Modify |
| `docs/ko/team-runbook.md` | Operator runbook — the `stale` paragraph | Modify |
| `docs/ko/artifacts.md` | Artifact/ledger reference — the sync-ledger section | Modify |

---

### Task 1: `LarkDriveUploader.update` replaces the published file

**Files:**
- Modify: `src/adapters/drive/LarkDriveUploader.ts`
- Test: `tests/adapters/drive/larkDriveUploader.test.ts`

**Interfaces:**
- Consumes: `DriveUploader.update?(remoteId: string, req: UploadRequest): Promise<UploadResult>` from `src/ports/DriveUploader.ts`; `UploadRequest = { name: string; content: string; folder: FolderKind }` and `UploadResult = { id: string; name: string; url?: string }` from `src/domain/publish/publishModels.ts`.
- Produces: `LarkDriveUploader.update(remoteId, req)` returning the **new** file's `UploadResult` (`id` is the new `file_token`). `PublishTranslations` writes that `id` into the ledger row's `remoteId`.

The existing tests use `fakeFetch(cap)`, which keeps only the **last** call. `update` makes two calls, and one test must assert that a call did *not* happen, so this task adds a second helper that records every call. Leave `fakeFetch` and the four existing tests untouched.

- [ ] **Step 1: Write the failing tests**

Add to `tests/adapters/drive/larkDriveUploader.test.ts`. Put the helper directly below the existing `fakeFetch` definition, and the `describe` block at the end of the file:

```ts
interface Call {
  url: string;
  method: string;
  form?: FormData;
}

/**
 * Records every call, unlike fakeFetch which keeps only the last. update() makes two requests, and
 * one test asserts a request was never made.
 */
function recordingFetch(calls: Call[], responses: Response[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("recordingFetch: no response queued");
    return next;
  }) as unknown as typeof fetch;
}

const okUpload = (fileToken: string) =>
  new Response(JSON.stringify({ code: 0, data: { file_token: fileToken } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const okDelete = () =>
  new Response(JSON.stringify({ code: 0, data: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
```

```ts
describe("LarkDriveUploader.update", () => {
  it("uploads the new content and returns the new file token", async () => {
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [okUpload("flk_new"), okDelete()]),
    );

    const result = await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "approved" });

    expect(result).toEqual({ id: "flk_new", name: "x-1.md" });
    expect(calls[0].url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/upload_all");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form?.get("parent_node")).toBe("APPROVED_TOKEN");
  });

  it("deletes the previous file by token, as type=file", async () => {
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [okUpload("flk_new"), okDelete()]),
    );

    await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "review" });

    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe("DELETE");
    expect(calls[1].url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/flk_old?type=file");
  });

  it("does not delete the previous file when the upload fails", async () => {
    // Deleting after a failed upload would destroy the only published copy.
    const calls: Call[] = [];
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [
        new Response(JSON.stringify({ code: 1061004, msg: "forbidden." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
    );

    await expect(uploader.update("flk_old", { name: "n", content: "c", folder: "review" })).rejects.toThrow(/1061004/);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
  });

  it("returns the new result and warns when deleting the previous file fails", async () => {
    // PublishTranslations records the ledger row only when update() returns. Throwing here would
    // leave the file just uploaded unrecorded, so the next run would upload yet another copy.
    const calls: Call[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const uploader = new LarkDriveUploader(
      auth,
      "https://open.larksuite.com",
      folders,
      recordingFetch(calls, [
        okUpload("flk_new"),
        new Response(JSON.stringify({ code: 1061045, msg: "no permission" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ]),
    );

    const result = await uploader.update("flk_old", { name: "x-1.md", content: "# v2", folder: "review" });

    expect(result).toEqual({ id: "flk_new", name: "x-1.md" });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("flk_old");
    expect(message).toContain("1061045");
    warn.mockRestore();
  });
});
```

Add `vi` to the vitest import at the top of the file:

```ts
import { describe, it, expect, vi } from "vitest";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/adapters/drive/larkDriveUploader.test.ts`
Expected: FAIL — `uploader.update is not a function` on all four new tests. The four pre-existing tests still pass.

- [ ] **Step 3: Implement `update` and `deletePrevious`**

In `src/adapters/drive/LarkDriveUploader.ts`, add both methods to the class, directly after `upload`:

```ts
  /**
   * Replace, not edit in place. Lark's drive/v1 has no content-replace endpoint — a same-name
   * upload_all creates a duplicate, PUT on the file 404s, and PATCH rejects every documented-looking
   * body with 981002 — so the new content goes up as a new file and the old one is deleted. The
   * file_token therefore changes on every republish, unlike Google's PATCH against a stable id.
   *
   * Upload runs first: the failure it allows is an orphan (two files, one of them stale), which is
   * recoverable by hand, where delete-first would allow a window with no file at all in a folder
   * reviewers read from.
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const result = await this.upload(req);
    await this.deletePrevious(remoteId, result.name);
    return result;
  }

  /**
   * Warns rather than throwing. PublishTranslations records the ledger row only when update()
   * returns, so throwing here would leave the file just uploaded unrecorded and the next run would
   * upload another copy — duplicates compounding on every run, which is what the sync ledger exists
   * to prevent. Warning keeps the ledger pointing at the live file and leaves at most one orphan.
   *
   * Because every failure is handled the same way, this never has to tell "already deleted by hand"
   * apart from "permission denied".
   */
  private async deletePrevious(remoteId: string, newName: string): Promise<void> {
    let detail = "";
    try {
      const token = await this.auth.getToken();
      const res = await this.fetchFn(
        `${this.baseUrl}/open-apis/drive/v1/files/${encodeURIComponent(remoteId)}?type=file`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) {
        const body = await extractLarkErrorDetail(res);
        detail = `HTTP ${res.status}${body ? ` — ${body}` : ""}`;
      } else {
        const data = (await res.json()) as { code?: number; msg?: string };
        if (data.code !== 0) detail = `code=${data.code} ${data.msg ?? ""}`.trim();
      }
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
    if (detail) {
      console.warn(
        `[lark] published ${newName} but could not delete the previous file ${remoteId}: ${detail} — ` +
          `delete it in Lark Drive by hand, or the folder will keep two copies of this item`,
      );
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/adapters/drive/larkDriveUploader.test.ts`
Expected: PASS — 8 tests (4 pre-existing + 4 new).

- [ ] **Step 5: Run the full check**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; the whole suite passes. `PublishTranslations`'s "cannot update in place" test (if it asserts on an uploader without `update`) must still pass — it uses its own fake uploader, not `LarkDriveUploader`.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/drive/LarkDriveUploader.ts tests/adapters/drive/larkDriveUploader.test.ts
git commit -m "feat: republish to Lark Drive by replacing the published file

Lark's drive/v1 offers create and delete but no content-replace: a same-name
upload_all duplicates, PUT 404s, and PATCH rejects every body tried with 981002.
So update() uploads the new file and deletes the old token, which changes the
file_token on every republish — the platform's cost, documented in the adapter.

Upload runs first so a failure never empties the folder, and a failed delete
warns instead of throwing: PublishTranslations records the ledger row only on a
successful return, so throwing would leave the new file unrecorded and upload
another copy next run, compounding duplicates."
```

---

### Task 2: Correct the two Korean documents that describe the old limitation

**Files:**
- Modify: `docs/ko/team-runbook.md` (the `stale` paragraph beginning **Google Drive와 로컬 대상에서만 동작합니다**)
- Modify: `docs/ko/artifacts.md` (the sync-ledger paragraph beginning **`stale`로 판정된 행은**)

**Interfaces:**
- Consumes: the behavior implemented in Task 1.
- Produces: nothing code-facing.

Both documents currently tell operators that Lark `stale` items fail and must be fixed by hand. After Task 1 that is false, and a runbook describing a workaround for a limitation that no longer exists is worse than the limitation.

- [ ] **Step 1: Replace the runbook paragraph**

In `docs/ko/team-runbook.md`, replace the paragraph that starts **`**Google Drive와 로컬 대상에서만 동작합니다.**`** and runs to `**찾아 지워야** 합니다 — 중복이 생기지 않습니다.` with:

```markdown
**세 대상 모두에서 동작하지만 방식이 다릅니다.** Google은 파일 id를 유지한 채 PATCH하고,
`local`(`LocalFileUploader`)은 파일을 다시 쓴 뒤 이름이 바뀌었으면 예전 파일을 지웁니다. Lark
Drive `drive/v1`에는 내용을 그 자리에서 바꾸는 엔드포인트가 없어(같은 이름으로 다시 올리면 중복이
생기고, `PUT`은 404, `PATCH`는 `981002 params error`) **새 파일을 올린 뒤 예전 파일을 삭제**하는
방식으로 교체합니다. 결과는 같습니다 — 폴더에는 항상 최신 파일 하나만 남습니다.

**단, Lark만 재게시할 때마다 `file_token`과 링크가 바뀝니다.** Google은 링크가 유지되므로, Lark
파일 주소를 어딘가에 붙여 두었다면 재게시 후 다시 가져와야 합니다.

예전 파일 삭제가 실패하면(권한 변경 등) 게시는 성공으로 처리하고 경고 한 줄을 남깁니다 —
`[lark] published <파일명> but could not delete the previous file <token> ...`. 원장은 항상 새
파일을 가리키므로 다음 실행에서 또 올리지는 않지만, 경고에 찍힌 그 `token`의 파일은 **직접 지워야**
폴더에 사본이 둘 남지 않습니다.
```

- [ ] **Step 2: Replace the artifacts paragraph**

In `docs/ko/artifacts.md`, replace the paragraph that starts **``stale`로 판정된 행은 대상이 Google 또는 `local`이면`** and runs to `Drive에서 직접 찾아 수동으로 처리해야 합니다.` with:

```markdown
`stale`로 판정된 행은 대상에 따라 다른 방식으로, 그러나 모두 중복 없이 재게시됩니다. Google은
파일 id·공유 링크를 유지한 채 PATCH하고, `local`(`LocalFileUploader.update`)은 새 내용을 다시 쓴
뒤 파일명이 바뀌었으면(예: 재승인으로 `approvedAt` 날짜가 바뀐 경우) 이전 파일을 지워 하나만
남깁니다. Lark(`LarkDriveUploader.update`)는 `drive/v1`에 콘텐츠 교체 API가 없어 **새 파일을 올린
뒤 예전 파일을 삭제**하므로, 폴더에는 하나만 남지만 **`file_token`과 링크는 매번 바뀝니다**. 예전
파일 삭제가 실패하면 게시는 성공으로 처리하고 고아 토큰을 경고로 남깁니다(원장은 새 파일을 가리키
므로 재업로드가 반복되지는 않습니다).
```

- [ ] **Step 3: Verify no stale claim survives**

Run: `grep -rn "Lark" docs/ko/team-runbook.md docs/ko/artifacts.md | grep -i "실패\|수동\|없어\|없으므로"`
Expected: every remaining hit describes the *new* behavior (no content-replace endpoint → upload+delete, token changes). No hit may still claim a Lark `stale` item is reported as a failure or must be published by hand.

- [ ] **Step 4: Commit**

```bash
git add docs/ko/team-runbook.md docs/ko/artifacts.md
git commit -m "docs: Lark stale items now republish instead of failing

Both documents told operators that a stale Lark item is reported as a failure
and must be fixed by hand. That workaround no longer exists. They now describe
the replace-by-delete mechanism and the one caveat it leaves: Lark's file_token
and link change on every republish, where Google's do not."
```

---

### Task 3: Verify against the live tenant

**Files:** none — this task only runs commands.

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces: evidence that a real republish leaves exactly one file in the Lark folder.

Requires a configured `.env` (`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_DRIVE_*_FOLDER_TOKEN`) and folders shared with the bot's group chat. **If those are absent, stop and report that this task cannot run** — do not fake it.

- [ ] **Step 1: Confirm the ledger already has Lark rows**

Run:

```bash
node -e 'const e=JSON.parse(require("fs").readFileSync("output/publish/state.json","utf8")).entries;console.log(e.filter(r=>r.target==="lark").map(r=>[r.status,r.fileName,r.remoteId].join(" ")).join("\n"))'
```

Expected: one line per already-published Lark item, each with a `remoteId`. If there are none, run `HERALD_STORAGE_MODE=cloud pnpm drive:publish --target lark` first so there is something to replace.

- [ ] **Step 2: Make one published item stale**

Mark **one** Lark row stale by corrupting its stored `contentHash` — never by editing a real translation. `output/publish/state.json` is derived state that this very run rewrites with the correct hash, so the check leaves no trace; `translations.json` holds Kyle's actual Korean copy and must not be edited to create a test fixture.

Back up first, then flip the hash of the first Lark row:

```bash
cp output/publish/state.json output/publish/state.json.bak
node -e '
const fs = require("fs");
const p = "output/publish/state.json";
const s = JSON.parse(fs.readFileSync(p, "utf8"));
const row = s.entries.find((r) => r.target === "lark" && r.contentHash);
if (!row) throw new Error("no lark row with a contentHash — run drive:publish --target lark first");
console.log("making stale:", row.itemId, row.status, "old remoteId:", row.remoteId);
row.contentHash = "0".repeat(row.contentHash.length);
fs.writeFileSync(p, JSON.stringify(s, null, 2));
'
```

Expected: it prints the `itemId`, `status`, and the **old** `remoteId` — record all three, Step 4 compares against them.

If anything in Steps 3-4 goes wrong, restore with `mv output/publish/state.json.bak output/publish/state.json`. On success, delete the backup.

- [ ] **Step 3: Republish and read the counters**

Run: `HERALD_STORAGE_MODE=cloud pnpm drive:publish --target lark`
Expected: `published 0 new + 1 updated across 1 drive(s); 0 failure(s)` and `by drive: {"lark":1}`. No `✗` line, and no `cannot update` message.

Only the row made stale in Step 2 should move — `1 updated`, not more.

- [ ] **Step 4: Confirm the folder holds one file, not two**

Save this as `check-dupes.mts` in the scratch directory (not in the repo) — `.mts` matters, `tsx` treats a bare `.ts` outside the project as CommonJS and rejects top-level `await`:

```ts
const base = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
const t = await (await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }),
})).json();
for (const [label, folder] of [["review", process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN], ["approved", process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN]]) {
  const r = await (await fetch(`${base}/open-apis/drive/v1/files?folder_token=${folder}&page_size=100`, {
    headers: { Authorization: `Bearer ${t.tenant_access_token}` },
  })).json();
  const names = (r.data?.files ?? []).map((f) => f.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  console.log(`${label}: ${names.length} files, duplicates: ${dupes.length ? dupes.join(", ") : "none"}`);
}
```

Then run it with the repo's `.env` loaded, the same way every CLI in this project does:

```bash
npx tsx --env-file-if-exists=.env <path-to>/check-dupes.mts
```

Expected: `duplicates: none` for both folders. Then confirm the row's `remoteId` in `output/publish/state.json` differs from the old `remoteId` printed in Step 2 — that difference is what proves the file was replaced rather than edited in place. Delete `output/publish/state.json.bak`.

- [ ] **Step 5: Report the evidence**

Paste the Step 3 counter line and the Step 4 duplicate check into the task report. Do not claim success without both.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Contract: `update` means replace | Task 1, Step 3 |
| Ordering: upload first, delete second | Task 1, Steps 1 (test 3) and 3 |
| Delete failure is a warning | Task 1, Steps 1 (test 4) and 3 |
| Error text names the orphan and the remedy | Task 1, Step 3 (`console.warn` string) |
| Testing: 4 unit tests, no live probe extension | Task 1, Step 1 |
| Documentation: runbook + artifacts | Task 2 |
| Out of scope: `PATCH`, docx import, recording a `url` | Global Constraints; no task touches them |

**Placeholder scan:** none — every step carries the literal code, command, or replacement prose.

**Type consistency:** `update(remoteId: string, req: UploadRequest): Promise<UploadResult>` matches the optional member in `src/ports/DriveUploader.ts`. `deletePrevious(remoteId: string, newName: string): Promise<void>` is private and used only by `update`. `extractLarkErrorDetail(res: Response): Promise<string>` already exists in the file and is reused unchanged.
