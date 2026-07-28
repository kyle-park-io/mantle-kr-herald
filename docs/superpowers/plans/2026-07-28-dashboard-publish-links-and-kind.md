# Dashboard: publish links + item-kind badge + annotation-preserve fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the review dashboard a fixed-order publish-status section with open-folder/open-file links for every Drive target, a post/article badge on translated items, and stop dashboard edits/approvals from dropping review-doc annotations.

**Architecture:** All URL construction happens server-side (the server holds the Drive config) via a pure `publishRowLinks` helper; `PublishStateRow` carries the resulting `folderUrl`/`fileUrl`. The post/article `kind` is **derived at read time** by joining translations to the collected content items (a pure `attachKind` helper) — never stored on `Translation`. The annotation fix passes the already-loaded `isReply`/`refUrl` through the three dashboard save paths.

**Tech Stack:** TypeScript (ESM, hexagonal ports/adapters), vitest, tsx; React 18 + Vite 5 + Tailwind v4 frontend.

## Global Constraints

- `kind` is DERIVED for the dashboard only. Do **NOT** modify `Translation` (`src/domain/translation/models.ts`), `SaveInput` (`src/app/SaveTranslation.ts`), or `src/cli/translate-save.ts`. Nothing in rendering/publishing reads `kind`.
- Repo is **PUBLIC**: never put real folder ids, Lark tokens, workspace URLs, post text, or PII in code or tests. Use obvious placeholders (`"GR"`, `"https://t.larksuite.com"`, etc.).
- Frontend uses **Tailwind v4** (no `tailwind.config.js`/`postcss.config.js`). Match the already-committed modern-minimal light styling — reuse existing classes (`text-mint`, `text-faint`, `border-line`, `eyebrow`, etc.).
- Do not change publishing behavior, the sync ledger, or the storage-mode-is-env-only rule.
- Restore `.env` to `HERALD_STORAGE_MODE=cloud` after any local-mode live test.
- Every task ends green on its own tests **and** `pnpm exec tsc --noEmit`. Frontend tasks also run `pnpm build:web`.

---

### Task 1: C — preserve review annotations on dashboard save

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts:85,91,104` (three `saveTranslation.run` call sites)
- Test: `tests/adapters/web/apiHandlers.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: `SaveInput` already accepts `isReply?: boolean; refUrl?: string;` (`src/app/SaveTranslation.ts:19-27`) — this task only starts passing them.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test** — append to `tests/adapters/web/apiHandlers.test.ts`:

```ts
describe("dashboard save preserves review annotations (isReply/refUrl)", () => {
  function recordingDeps(over: Partial<Translation> = {}) {
    const calls: any[] = [];
    const d = makeDeps([tr({ itemId: "x:1", isReply: true, refUrl: "https://x.com/i/status/1", ...over })]);
    d.saveTranslation = {
      run: async (input: any) => { calls.push(input); return { itemId: input.itemId, promoted: false }; },
    } as unknown as ApiDeps["saveTranslation"];
    return { d, calls };
  }

  it("PUT edit forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps();
    await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "새 번역" });
    expect(calls[0]).toMatchObject({ koreanText: "새 번역", approve: false, isReply: true, refUrl: "https://x.com/i/status/1" });
  });

  it("POST approve forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps();
    await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined);
    expect(calls[0]).toMatchObject({ approve: true, isReply: true, refUrl: "https://x.com/i/status/1" });
  });

  it("POST unapprove forwards isReply/refUrl from the existing translation", async () => {
    const { d, calls } = recordingDeps({ status: "approved", approvedAt: "a" });
    await handleApi(d, "POST", "/api/translations/x%3A1/unapprove", undefined);
    expect(calls[0]).toMatchObject({ approve: false, isReply: true, refUrl: "https://x.com/i/status/1" });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (the run args lack `isReply`/`refUrl`):

Run: `pnpm exec vitest run tests/adapters/web/apiHandlers.test.ts -t "preserves review annotations"`
Expected: FAIL (`isReply`/`refUrl` undefined in the recorded call).

- [ ] **Step 3: Fix the three call sites** in `src/adapters/web/apiHandlers.ts`. Add `isReply: existing.isReply, refUrl: existing.refUrl` to each `saveTranslation.run({ … })`:
  - line 85 (PUT edit): `…koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });`
  - line 91 (POST approve): `…koreanText: existing.koreanText, approve: true, isReply: existing.isReply, refUrl: existing.refUrl });`
  - line 104 (POST unapprove): `…koreanText: existing.koreanText, approve: false, isReply: existing.isReply, refUrl: existing.refUrl });`

- [ ] **Step 4: Run tests + typecheck — expect PASS**

Run: `pnpm exec vitest run tests/adapters/web/apiHandlers.test.ts && pnpm exec tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "fix(dashboard): preserve isReply/refUrl on edit/approve/unapprove"
```

---

### Task 2: A backend — publish-row folder/file links

**Files:**
- Create: `src/adapters/web/publishLinks.ts`
- Test: `tests/adapters/web/publishLinks.test.ts`
- Modify: `src/adapters/web/apiHandlers.ts` (`PublishStateRow` gains two optional fields)
- Modify: `src/cli/serve.ts` (build link config, enrich `loadPublishState`)

**Interfaces:**
- Consumes: `GoogleDriveConfig.{reviewFolderId,approvedFolderId}` and `LarkDriveConfig.{workspaceUrl?,reviewFolderToken,approvedFolderToken}` (loaded in `serve.ts`).
- Produces: `publishRowLinks(row, cfg): { folderUrl?, fileUrl? }`, `PublishLinkConfig`, `PublishRowInput`.

- [ ] **Step 1: Write the failing test** — `tests/adapters/web/publishLinks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { publishRowLinks, type PublishLinkConfig } from "../../../src/adapters/web/publishLinks";

const cfg: PublishLinkConfig = {
  google: { reviewFolderId: "GR", approvedFolderId: "GA" },
  lark: { workspaceUrl: "https://t.larksuite.com", reviewFolderToken: "LR", approvedFolderToken: "LA" },
};

describe("publishRowLinks", () => {
  it("google translated → review folder + webViewLink file", () => {
    expect(publishRowLinks({ target: "google", status: "translated", url: "https://drive/f1" }, cfg))
      .toEqual({ folderUrl: "https://drive.google.com/drive/folders/GR", fileUrl: "https://drive/f1" });
  });
  it("google approved → approved folder", () => {
    expect(publishRowLinks({ target: "google", status: "approved", url: "u" }, cfg).folderUrl)
      .toBe("https://drive.google.com/drive/folders/GA");
  });
  it("lark translated → workspace review folder + file url from remoteId", () => {
    expect(publishRowLinks({ target: "lark", status: "translated", remoteId: "TK" }, cfg))
      .toEqual({ folderUrl: "https://t.larksuite.com/drive/folder/LR", fileUrl: "https://t.larksuite.com/file/TK" });
  });
  it("lark approved → approved folder token", () => {
    expect(publishRowLinks({ target: "lark", status: "approved", remoteId: "TK" }, cfg).folderUrl)
      .toBe("https://t.larksuite.com/drive/folder/LA");
  });
  it("lark without remoteId → no fileUrl", () => {
    expect(publishRowLinks({ target: "lark", status: "translated" }, cfg).fileUrl).toBeUndefined();
  });
  it("local → both undefined (frontend builds the local file link)", () => {
    expect(publishRowLinks({ target: "local", status: "translated", remoteId: "approved/x.md" }, cfg)).toEqual({});
  });
  it("no google config → no folderUrl but keeps the file webViewLink", () => {
    expect(publishRowLinks({ target: "google", status: "translated", url: "u" }, {}))
      .toEqual({ folderUrl: undefined, fileUrl: "u" });
  });
  it("no lark config → empty", () => {
    expect(publishRowLinks({ target: "lark", status: "translated", remoteId: "TK" }, {})).toEqual({});
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing):

Run: `pnpm exec vitest run tests/adapters/web/publishLinks.test.ts`
Expected: FAIL (cannot find `publishLinks`).

- [ ] **Step 3: Implement** `src/adapters/web/publishLinks.ts`:

```ts
// src/adapters/web/publishLinks.ts
export interface PublishLinkConfig {
  google?: { reviewFolderId: string; approvedFolderId: string };
  lark?: { workspaceUrl: string; reviewFolderToken: string; approvedFolderToken: string };
}

export interface PublishRowInput {
  target: string; // "local" | "google" | "lark"
  status: string; // "translated" | "approved"
  url?: string; // Google webViewLink from the ledger
  remoteId?: string; // Google fileId / Lark file_token
}

/**
 * Folder- and file-open URLs for a published row. Pure. Folder selection mirrors
 * PublishTranslations: approved → the approved folder, otherwise the review folder.
 * Any missing input (no config, no remoteId) yields undefined for that URL — never a broken link.
 */
export function publishRowLinks(
  row: PublishRowInput,
  cfg: PublishLinkConfig,
): { folderUrl?: string; fileUrl?: string } {
  const approved = row.status === "approved";
  if (row.target === "google") {
    const folderId = cfg.google ? (approved ? cfg.google.approvedFolderId : cfg.google.reviewFolderId) : undefined;
    return {
      folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : undefined,
      fileUrl: row.url,
    };
  }
  if (row.target === "lark") {
    if (!cfg.lark) return {};
    const token = approved ? cfg.lark.approvedFolderToken : cfg.lark.reviewFolderToken;
    const ws = cfg.lark.workspaceUrl;
    return {
      folderUrl: `${ws}/drive/folder/${token}`,
      fileUrl: row.remoteId ? `${ws}/file/${row.remoteId}` : undefined,
    };
  }
  return {}; // local: browser can't open a local dir; the file link is built by the frontend
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm exec vitest run tests/adapters/web/publishLinks.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `PublishStateRow`** in `src/adapters/web/apiHandlers.ts:22-29` — add two optional fields (no handler logic changes; the existing `/api/publish/state` test still passes because the fake `loadPublishState` returns rows without them):

```ts
export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
  folderUrl?: string; // NEW — "open folder" for Google/Lark
  fileUrl?: string;   // NEW — "open file" for Google/Lark
}
```

- [ ] **Step 6: Wire `serve.ts`.** Add the import, build the link config once, and enrich `loadPublishState`:

At the imports, add:
```ts
import { publishRowLinks, type PublishLinkConfig } from "../adapters/web/publishLinks";
```

After the `usableTargets` block (near `src/cli/serve.ts:54`), build the config best-effort (mirrors the existing try/catch pattern; Lark only when a workspace URL is set):
```ts
const linkCfg: PublishLinkConfig = {};
if (storageMode === "cloud") {
  try {
    const g = loadGoogleDriveConfig();
    linkCfg.google = { reviewFolderId: g.reviewFolderId, approvedFolderId: g.approvedFolderId };
  } catch {
    /* Google not configured — no Google folder links */
  }
  try {
    const l = loadLarkDriveConfig();
    if (l.workspaceUrl) {
      linkCfg.lark = { workspaceUrl: l.workspaceUrl, reviewFolderToken: l.reviewFolderToken, approvedFolderToken: l.approvedFolderToken };
    }
  } catch {
    /* Lark not configured — no Lark links */
  }
}
```

Replace `loadPublishState` (`src/cli/serve.ts:95-103`) so each row is spread with its links:
```ts
const loadPublishState = async (): Promise<PublishStateRow[]> =>
  (await publishStore.listEntries()).map((e) => ({
    itemId: e.itemId,
    status: e.status,
    target: e.target,
    url: e.url,
    remoteId: e.remoteId,
    fileName: e.fileName,
    ...publishRowLinks({ target: e.target, status: e.status, url: e.url, remoteId: e.remoteId }, linkCfg),
  }));
```

- [ ] **Step 7: Run the web tests + typecheck — expect PASS**

Run: `pnpm exec vitest run tests/adapters/web && pnpm exec tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/web/publishLinks.ts tests/adapters/web/publishLinks.test.ts src/adapters/web/apiHandlers.ts src/cli/serve.ts
git commit -m "feat(dashboard): server-computed folder/file links on publish-state rows"
```

---

### Task 3: B backend — derive post/article kind at read time

**Files:**
- Create: `src/adapters/web/attachKind.ts`
- Test: `tests/adapters/web/attachKind.test.ts`
- Modify: `src/adapters/web/apiHandlers.ts` (`ApiDeps.loadTranslations`, `GET /api/translations`)
- Modify: `tests/adapters/web/apiHandlers.test.ts` (`makeDeps` gains `loadTranslations`)
- Modify: `src/cli/serve.ts` (wire `loadTranslations`)

**Interfaces:**
- Consumes: `Translation` (`itemId`), `ContentItem` (`id`, `kind?`), `contentSource.loadPending(new Set())` (returns all active collected items with `kind`).
- Produces: `attachKind(translations, items): ApiTranslation[]`, `ApiTranslation = Translation & { kind?: "post" | "article" }`.

- [ ] **Step 1: Write the failing test** — `tests/adapters/web/attachKind.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { attachKind } from "../../../src/adapters/web/attachKind";
import type { Translation } from "../../../src/domain/translation/models";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const tr = (itemId: string): Translation =>
  ({ itemId, source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" });
const item = (id: string, kind?: "post" | "article"): ContentItem =>
  ({ id, source: "x", text: "x", createdAt: "c", kind });

describe("attachKind", () => {
  it("attaches each source item's kind by itemId", () => {
    const [r] = attachKind([tr("x:1")], [item("x:1", "article")]);
    expect(r.kind).toBe("article");
  });
  it("leaves kind undefined when the source item is absent", () => {
    const [r] = attachKind([tr("x:9")], [item("x:1", "post")]);
    expect(r.kind).toBeUndefined();
  });
  it("does not mutate the input translation", () => {
    const input = tr("x:1");
    attachKind([input], [item("x:1", "post")]);
    expect("kind" in input).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (module missing):

Run: `pnpm exec vitest run tests/adapters/web/attachKind.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `src/adapters/web/attachKind.ts`:

```ts
// src/adapters/web/attachKind.ts
import type { Translation } from "../../domain/translation/models";
import type { ContentItem } from "../../domain/translation/contentItem";

export type ApiTranslation = Translation & { kind?: "post" | "article" };

/**
 * Attach each source item's `kind` (post/article) to its translation, joined by itemId.
 * Display-only: `kind` is never persisted on Translation. Pure; does not mutate inputs.
 * A translation whose source item is absent (aged out, or a Lark item) gets no kind.
 */
export function attachKind(translations: Translation[], items: ContentItem[]): ApiTranslation[] {
  const kindById = new Map(items.map((i) => [i.id, i.kind] as const));
  return translations.map((t) => ({ ...t, kind: kindById.get(t.itemId) }));
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm exec vitest run tests/adapters/web/attachKind.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the dep + route** in `src/adapters/web/apiHandlers.ts`:

Add the import at the top:
```ts
import type { ApiTranslation } from "./attachKind";
```
Add to `ApiDeps` (after `loadPublishState`, `src/adapters/web/apiHandlers.ts:46`):
```ts
  loadTranslations: () => Promise<ApiTranslation[]>;
```
Change `GET /api/translations` (`src/adapters/web/apiHandlers.ts:71-73`) to use it:
```ts
  if (method === "GET" && segments.length === 2 && segments[1] === "translations") {
    return { status: 200, json: await deps.loadTranslations() };
  }
```

- [ ] **Step 6: Update `makeDeps`** in `tests/adapters/web/apiHandlers.test.ts` so `ApiDeps` type-checks and the existing GET test still passes. Add to the returned object (near `loadPublishState`, ~line 84):
```ts
    loadTranslations: async () => state.list,
```
Then add one assertion that the route carries kind — append inside the main `describe("handleApi", …)`:
```ts
  it("GET /api/translations returns whatever loadTranslations provides (with kind)", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    d.loadTranslations = async () => [{ ...tr({ itemId: "x:1" }), kind: "article" as const }];
    const res = await handleApi(d, "GET", "/api/translations", undefined);
    expect((res.json as any[])[0].kind).toBe("article");
  });
```

- [ ] **Step 7: Wire `serve.ts`.** Add the import and the dep:
```ts
import { attachKind } from "../adapters/web/attachKind";
```
Define alongside the other loaders (near `src/cli/serve.ts:95`):
```ts
const loadTranslations = async () =>
  attachKind(await translationStore.loadAll(), await contentSource.loadPending(new Set()));
```
Add `loadTranslations` to the `deps` object (`src/cli/serve.ts:105-116`).

- [ ] **Step 8: Run web tests + typecheck — expect PASS**

Run: `pnpm exec vitest run tests/adapters/web && pnpm exec tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/web/attachKind.ts tests/adapters/web/attachKind.test.ts src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts src/cli/serve.ts
git commit -m "feat(dashboard): derive post/article kind for the translations list"
```

---

### Task 4: A frontend — fixed-order publish rows with folder/file links

**Files:**
- Modify: `web/src/types.ts:52-59` (`PublishStateRow` gains `folderUrl?`/`fileUrl?`)
- Modify: `web/src/components/TranslationDetail.tsx:137-172` (sort + render links)

**Interfaces:**
- Consumes: `PublishStateRow.folderUrl?`, `PublishStateRow.fileUrl?` from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Extend the frontend type** — `web/src/types.ts`, `PublishStateRow`:
```ts
export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
  folderUrl?: string;
  fileUrl?: string;
}
```

- [ ] **Step 2: Sort + render links** — replace the `<ul>` body of the 발행 상태 section in `web/src/components/TranslationDetail.tsx` (currently lines 142-170). Sort by a fixed target rank and give Google/Lark both links, local the file link only:

```tsx
          <ul className="flex flex-col gap-1.5">
            {[...props.publishRows]
              .sort((a, b) => (TARGET_RANK[a.target] ?? 9) - (TARGET_RANK[b.target] ?? 9))
              .map((r) => (
                <li
                  key={`${r.status}:${r.target}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]"
                >
                  <span className="font-mono text-[11px] text-faint uppercase">{r.target}</span>
                  <span className="text-muted">{r.status}</span>
                  <span className="ml-auto flex items-center gap-3">
                    {r.target === "local" ? (
                      r.remoteId ? (
                        <a
                          className="text-mint underline-offset-2 hover:underline"
                          href={`/api/publish/local/${r.remoteId.split("/").map(encodeURIComponent).join("/")}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          파일 열기 ↗
                        </a>
                      ) : (
                        <span className="text-faint">링크 없음</span>
                      )
                    ) : r.folderUrl || r.fileUrl ? (
                      <>
                        {r.folderUrl && (
                          <a className="text-mint underline-offset-2 hover:underline" href={r.folderUrl} target="_blank" rel="noreferrer">
                            폴더 열기 ↗
                          </a>
                        )}
                        {r.fileUrl && (
                          <a className="text-mint underline-offset-2 hover:underline" href={r.fileUrl} target="_blank" rel="noreferrer">
                            파일 열기 ↗
                          </a>
                        )}
                      </>
                    ) : (
                      <span className="text-faint">링크 없음</span>
                    )}
                  </span>
                </li>
              ))}
          </ul>
```

Add the rank map near the top of the file (below `TARGET_LABEL`, `web/src/components/TranslationDetail.tsx:10`):
```ts
const TARGET_RANK: Record<string, number> = { local: 0, google: 1, lark: 2 };
```

- [ ] **Step 3: Typecheck + build — expect success**

Run: `pnpm exec tsc --noEmit && pnpm build:web`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/components/TranslationDetail.tsx
git commit -m "feat(dashboard): fixed local→google→lark order + folder/file links"
```

---

### Task 5: B frontend — post/article badge

**Files:**
- Modify: `web/src/types.ts:5-13` (`Translation` gains `kind?`)
- Modify: `web/src/components/TranslationList.tsx` (export `KindBadge`, show it in the row)
- Modify: `web/src/components/TranslationDetail.tsx` (show `KindBadge` in the header)

**Interfaces:**
- Consumes: `Translation.kind?` from Task 3's DTO.
- Produces: `KindBadge` (exported from `TranslationList.tsx`).

- [ ] **Step 1: Extend the frontend type** — `web/src/types.ts`, `Translation`:
```ts
export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: "translated" | "approved";
  translatedAt: string;
  approvedAt?: string;
  kind?: "post" | "article";
}
```

- [ ] **Step 2: Add `KindBadge`** to `web/src/components/TranslationList.tsx` (below `StatusChip`, ~line 24). Quiet neutral styling so it does not compete with the mint/amber status chip; renders nothing when `kind` is undefined:
```tsx
export function KindBadge({ kind }: { kind?: "post" | "article" }) {
  if (!kind) return null;
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted">
      {kind === "article" ? "아티클" : "포스트"}
    </span>
  );
}
```

- [ ] **Step 3: Show it in the list row.** In `web/src/components/TranslationList.tsx`, put the badge before the status chip in the row header (the `<div className="flex items-center gap-2">` around line 67):
```tsx
                  <div className="flex items-center gap-2">
                    <code className="truncate font-mono text-[11px] text-faint">{t.itemId}</code>
                    <span className="ml-auto flex items-center gap-1.5">
                      <KindBadge kind={t.kind} />
                      <StatusChip status={t.status} />
                    </span>
                  </div>
```

- [ ] **Step 4: Show it in the detail header.** In `web/src/components/TranslationDetail.tsx`, import `KindBadge` alongside `StatusChip` (line 4: `import { StatusChip, KindBadge } from "./TranslationList";`) and add `<KindBadge kind={props.item.kind} />` next to the source chip / `StatusChip` in the header block (around line 58-61):
```tsx
        <KindBadge kind={props.item.kind} />
        <StatusChip status={props.item.status} />
```

- [ ] **Step 5: Typecheck + build — expect success**

Run: `pnpm exec tsc --noEmit && pnpm build:web`
Expected: no type errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/components/TranslationList.tsx web/src/components/TranslationDetail.tsx
git commit -m "feat(dashboard): post/article badge on translated items"
```

---

## Post-implementation verification (controller, after all tasks)

- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean; `pnpm build:web` succeeds.
- **Local-mode live check:** set `.env` `HERALD_STORAGE_MODE=local`, `pnpm serve`, publish one keeper to local → its row shows `로컬` first with `파일 열기`; translated items show `포스트`/`아티클` badges; edit a keeper and confirm the review doc keeps its `[원문]`/reply marker. **Restore `.env` to cloud after.**
- **Cloud-mode link check:** with cloud `.env`, publish one item to google (and lark if configured) → verify `폴더 열기`/`파일 열기` open the right Drive folder and file. **Verify the Lark file URL pattern `<workspace>/file/<token>`; if Lark opens files at a different path, fix `publishRowLinks` only.**

## Self-review notes

- Spec coverage: A = Tasks 2+4; B = Tasks 3+5; C = Task 1. All spec sections mapped.
- Global constraint honored: no change to `Translation`/`SaveInput`/`translate-save.ts` (kind derived in Task 3).
- Type consistency: `PublishStateRow` fields match across `apiHandlers.ts` (Task 2) and `web/src/types.ts` (Task 4); `ApiTranslation`/`kind` match across `attachKind.ts` (Task 3) and `web/src/types.ts` (Task 5).
