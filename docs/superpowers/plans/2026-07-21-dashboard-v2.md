# Review Dashboard v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move publishing from a global header bar to per-item, per-target buttons in the detail pane, add un-approve, surface which targets are usable, remove the header PublishBar (fixing the 1차/2차 vertical shift), fix badge contrast, link X items to the tweet, bump fonts, and add web-font MIME types.

**Architecture:** Reuse existing use-cases — per-item publish is `PublishTranslations` with an `itemId` filter and a single-target uploader; un-approve is `SaveTranslation` with `approve:false`. The frontend gets the usable targets from a new `availableTargets` field on `GET /api/status`. No new use-case or port; no runtime mode toggle.

**Tech Stack:** TypeScript (ESM, hexagonal), `zod`-only Node backend, `node:http`, React + Vite + Tailwind v4 (build-time devDeps), vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-dashboard-v2-design.md`

## Global Constraints

- Node backend runtime deps stay **`zod`-only**; the frontend is build-time devDeps only.
- Code/comments in **English**; user-visible UI strings stay **Korean** (`로컬 저장`, `승인 취소`, etc.).
- **Reuse existing use-cases** — no new use-case or port. Per-item publish = `PublishTranslations` with an `itemId` filter; un-approve = `SaveTranslation` `approve:false`.
- **The header `PublishBar` is removed entirely**; the global `POST /api/publish` route and `ApiDeps.buildPublisher` go with it (per-item `publishOne` replaces them). `resolveTargets`/`createUploaders` stay — `publishOne` reuses them. Batch publish stays in `pnpm drive:publish`.
- **`availableTargets`** on `GET /api/status`: `local` always; `google`/`lark` only when `storageMode === "cloud"` AND the target's config loads. Buttons enable exactly for these.
- **No runtime mode toggle** — `HERALD_STORAGE_MODE` stays `.env`-driven.
- `main` is branch-protected. Work on `feat/dashboard-v2` (already created; the spec commit is on it). Integration by PR.
- Verification: `pnpm test` + `pnpm typecheck` (backend tasks); `pnpm typecheck:web` + `pnpm build:web` (frontend tasks); the whole-branch step also runs `pnpm serve`.

### `history` translations status values

A `Translation.status` is `"translated"` or `"approved"` (`src/domain/translation/models.ts`). Approve sets `approved` + `approvedAt`; un-approve reverts to `translated`.

---

### Task 1: `PublishTranslations.run({ itemId })` filter

**Files:**
- Modify: `src/app/PublishTranslations.ts`
- Test: `tests/app/publishTranslations.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PublishTranslations.run(opts?: { itemId?: string }): Promise<PublishResult>` — with `itemId`, only that translation is published; without, all of them (unchanged).

- [ ] **Step 1: Write the failing test**

In `tests/app/publishTranslations.test.ts`, add this test inside the `describe("PublishTranslations", ...)` block (it uses the file's existing `FakeUploader`, `translationStore`, `tr`, and `InMemoryPublishStore` helpers):

```ts
  it("publishes only the named item when run is given an itemId", async () => {
    const g = new FakeUploader("google");
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "approved"), tr("x:2", "approved")]), [g], store);

    const res = await uc.run({ itemId: "x:2" });

    expect(g.reqs.map((r) => r.name)).toHaveLength(1);
    expect(res.uploaded).toBe(1);
    expect(store.entries.map((e) => e.itemId)).toEqual(["x:2"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/app/publishTranslations.test.ts`
Expected: FAIL — `run` takes no argument (TS is stripped at runtime, so it fails on the assertion: both items publish, `reqs` has length 2).

- [ ] **Step 3: Add the filter**

In `src/app/PublishTranslations.ts`, change the `run` signature and the load line. The method currently starts:

```ts
  async run(): Promise<PublishResult> {
    const entries = await this.publishStore.listEntries();
```
and loops `for (const t of await this.translationStore.loadAll()) {`. Change to:

```ts
  async run(opts: { itemId?: string } = {}): Promise<PublishResult> {
    const entries = await this.publishStore.listEntries();
```
and replace the loop header:

```ts
    const all = await this.translationStore.loadAll();
    const translations = opts.itemId ? all.filter((t) => t.itemId === opts.itemId) : all;
    for (const t of translations) {
```
(everything inside the loop is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — the new test plus every existing no-arg `run()` test.

- [ ] **Step 5: Commit**

```bash
git add src/app/PublishTranslations.ts tests/app/publishTranslations.test.ts
git commit -m "feat(publish): PublishTranslations.run accepts an optional itemId filter"
```

---

### Task 2: Backend API — per-item publish, un-approve, availableTargets; remove global publish

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts` (`ApiDeps`, `StatusView`, routes)
- Modify: `src/cli/serve.ts` (deps: add `publishOne` + `availableTargets`, remove `buildPublisher`)
- Test: `tests/adapters/web/apiHandlers.test.ts`, `tests/adapters/web/httpServer.test.ts`

**Interfaces:**
- Consumes: `PublishTranslations.run({ itemId })` (Task 1); `resolveTargets`/`createUploaders` (`src/cli/uploaders.ts`); `SaveTranslation`; `loadGoogleAuthConfig`/`loadGoogleDriveConfig`/`loadLarkDriveConfig` (`src/config.ts`); `PublishResult` (`src/app/PublishTranslations.ts`).
- Produces:
  - `StatusView` gains `availableTargets: ("local" | "google" | "lark")[]`.
  - `ApiDeps` gains `publishOne: (id: string, target: string) => Promise<PublishResult>` and **loses** `buildPublisher`.
  - Routes: `POST /api/translations/:id/publish` (body `{ target }`) → `PublishResult`; `POST /api/translations/:id/unapprove` → the reverted `Translation`. The global `POST /api/publish` route is removed.

- [ ] **Step 1: Write the failing tests**

In `tests/adapters/web/apiHandlers.test.ts`: (a) in `makeDeps`, **remove** the `buildPublisher` property and **add** `publishOne` + extend the `loadStatus` fake with `availableTargets`:

```ts
    publishOne: async (_id: string, target: string) => ({ uploaded: 1, updated: 0, failed: 0, failures: [], byDrive: { [target]: 1 } }),
```
and in the `loadStatus` fake's returned object add `availableTargets: ["local"]`.
(b) Delete the existing `POST /api/publish` test (the "runs the publisher" one). (c) Append:

```ts
  it("POST /api/translations/:id/publish publishes just that item to the target", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/publish", { target: "local" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ uploaded: 1, updated: 0, failed: 0, failures: [], byDrive: { local: 1 } });
  });

  it("POST /api/translations/:id/publish is 400 without a target", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/publish", {});
    expect(res.status).toBe(400);
  });

  it("POST /api/translations/:id/unapprove reverts approved → translated", async () => {
    const d = makeDeps([tr({ itemId: "x:1", status: "approved", approvedAt: "a" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/unapprove", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("translated");
  });

  it("GET /api/status includes availableTargets", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/status", undefined);
    expect((res.json as { availableTargets: string[] }).availableTargets).toEqual(["local"]);
  });
```

In `tests/adapters/web/httpServer.test.ts`'s `fakeDeps()`: **remove** the `buildPublisher` line and **add** `publishOne: async () => ({ uploaded: 0, updated: 0, failed: 0, failures: [], byDrive: {} }),`, and add `availableTargets: ["local"]` to the `loadStatus` fake's returned object.

Note: `makeDeps`'s `saveTranslation` fake already flips status by `approve` (it returns a `translated` item when `approve:false`), so the un-approve test passes through it — verify that fake honours `approve:false` (it sets `status: input.approve ? "approved" : "translated"`); if it hard-codes a status, adjust it to honour `approve`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — the publish/unapprove routes 404, `availableTargets` is missing, and `pnpm typecheck` (Step 5) rejects the removed `buildPublisher` / new `publishOne`.

- [ ] **Step 3: Edit `apiHandlers.ts`**

Add the `PublishResult` import:
```ts
import type { PublishResult } from "../../app/PublishTranslations";
```
In `StatusView`, add the field:
```ts
  availableTargets: ("local" | "google" | "lark")[];
```
In `ApiDeps`, remove the `buildPublisher` line and add:
```ts
  publishOne: (id: string, target: string) => Promise<PublishResult>;
```
Remove the whole global publish route:
```ts
  if (method === "POST" && segments.length === 2 && segments[1] === "publish") {
    const target = (body as { target?: string })?.target;
    const pub = await deps.buildPublisher(target);
    return { status: 200, json: await pub.run() };
  }
```
In the `if (segments[1] === "translations" && segments.length >= 3)` block, after the existing `approve` route, add:
```ts
    if (method === "POST" && segments.length === 4 && segments[3] === "publish") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      const target = (body as { target?: unknown })?.target;
      if (typeof target !== "string" || target === "") return { status: 400, json: { error: "target required" } };
      return { status: 200, json: await deps.publishOne(existing.itemId, target) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "unapprove") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: false });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
```

- [ ] **Step 4: Edit `serve.ts`**

Add imports (some may already be present — do not duplicate):
```ts
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { PublishResult } from "../app/PublishTranslations";
```
After `const storageMode = loadStorageMode();`, compute the usable targets once:
```ts
const usableTargets = ((): ("local" | "google" | "lark")[] => {
  const targets: ("local" | "google" | "lark")[] = ["local"];
  if (storageMode === "cloud") {
    try {
      loadGoogleAuthConfig();
      loadGoogleDriveConfig();
      targets.push("google");
    } catch {
      /* Google not configured — omit */
    }
    try {
      loadLarkDriveConfig();
      targets.push("lark");
    } catch {
      /* Lark not configured — omit */
    }
  }
  return targets;
})();
```
In `loadStatus`'s returned object, add `availableTargets: usableTargets,`.
Add the `publishOne` composition (near `loadStatus`/`loadPublishState`):
```ts
const publishOne = async (itemId: string, target: string): Promise<PublishResult> =>
  new PublishTranslations(
    translationStore,
    await createUploaders(resolveTargets(target, storageMode)),
    publishStore,
  ).run({ itemId });
```
In the `deps` object, remove the `buildPublisher: …` line and add `publishOne,`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/apiHandlers.ts src/cli/serve.ts tests/adapters/web/apiHandlers.test.ts tests/adapters/web/httpServer.test.ts
git commit -m "feat(web): per-item publish + unapprove routes, availableTargets; drop global publish"
```

---

### Task 3: Web-font MIME types in `HttpServer`

**Files:**
- Modify: `src/adapters/web/HttpServer.ts` (MIME map)
- Test: `tests/adapters/web/httpServer.test.ts`

**Interfaces:** none consumed downstream.

- [ ] **Step 1: Write the failing test**

In `tests/adapters/web/httpServer.test.ts`, append inside `describe("startServer", ...)`:

```ts
  it("serves a .woff2 font with the font/woff2 content-type", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "assets", "font.woff2"), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    const base = await start(dir);

    const res = await fetch(`${base}/assets/font.woff2`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
  });
```
(`mkdir` is imported from `node:fs/promises` in this file per Task 2 of the #45 work; if it is not, add it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/adapters/web/httpServer.test.ts`
Expected: FAIL — content-type is `application/octet-stream`, not `font/woff2`.

- [ ] **Step 3: Add the MIME entries**

In `src/adapters/web/HttpServer.ts`, add to the `MIME` map:
```ts
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/HttpServer.ts tests/adapters/web/httpServer.test.ts
git commit -m "feat(web): serve bundled fonts with font/* content-types"
```

---

### Task 4: Frontend publish UX — per-target buttons, un-approve, remove PublishBar, badge contrast

**Files:**
- Modify: `web/src/types.ts` (add `availableTargets`; remove now-unused `AppConfig` if nothing references it)
- Modify: `web/src/api.ts` (remove `config`, `publish`; add `publishOne`, `unapprove`)
- Delete: `web/src/components/PublishBar.tsx`
- Modify: `web/src/App.tsx` (remove PublishBar, badge contrast, pass `availableTargets`/`onPublish`/`onUnapprove`)
- Modify: `web/src/components/TranslationDetail.tsx` (target buttons + 승인 취소)

**Interfaces:**
- Consumes: `GET /api/status.availableTargets` (Task 2), `api.publishOne`/`api.unapprove`.
- Produces: nothing downstream.

- [ ] **Step 1: types + api**

In `web/src/types.ts`, add `availableTargets` to `AppStatus`:
```ts
export interface AppStatus {
  storageMode: StorageMode;
  availableTargets: ("local" | "google" | "lark")[];
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { published: number; unsynced: number; stale: number };
}
```
Check whether `AppConfig` is still referenced (it was only used by `PublishBar`/`api.config`); if not, remove the `AppConfig` interface. In `web/src/api.ts`, remove the `config` and `publish` entries and the now-unused type imports (`AppConfig`, `PublishResult` stays — see below), and add:
```ts
  publishOne: (id: string, target: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }).then((r) => json<PublishResult>(r)),
  unapprove: (id: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/unapprove`, { method: "POST" }).then((r) => json<Translation>(r)),
```
(`PublishResult` is already imported in `api.ts`; keep it. Remove `AppConfig` from the import if you removed the interface.)

- [ ] **Step 2: delete PublishBar, edit App.tsx**

Delete the file:
```bash
git rm web/src/components/PublishBar.tsx
```
In `web/src/App.tsx`: remove the `import { PublishBar }` line and the `{mode === "translations" && <PublishBar />}` from the header. Restyle the mode badge for contrast — replace its className with a solid high-contrast chip:
```tsx
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded ${status.storageMode === "cloud" ? "bg-green-500 text-white" : "bg-amber-400 text-neutral-900"}`}
              >
                {status.storageMode}
              </span>
```
Add publish/unapprove handlers inside `App()` (near `onApprove`):
```tsx
  const onPublishOne = async (id: string, target: string) => {
    setError(null);
    try {
      await api.publishOne(id, target);
      await api.publishState().then(setPublishRows);
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onUnapprove = async (id: string) => {
    setError(null);
    try {
      await api.unapprove(id);
      await refresh();
      refreshStatus();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
```
Pass the new props where `TranslationDetail` is rendered:
```tsx
                <TranslationDetail
                  item={selected}
                  publishRows={publishRows.filter((r) => r.itemId === selected.itemId)}
                  availableTargets={status?.availableTargets ?? []}
                  onSave={onSave}
                  onApprove={onApprove}
                  onUnapprove={onUnapprove}
                  onPublish={onPublishOne}
                  onDirtyChange={setDirty}
                />
```

- [ ] **Step 3: TranslationDetail — target buttons + 승인 취소**

In `web/src/components/TranslationDetail.tsx`, extend the props type with:
```tsx
  availableTargets: ("local" | "google" | "lark")[];
  onUnapprove: (id: string) => Promise<void>;
  onPublish: (id: string, target: string) => Promise<void>;
```
Replace the existing action-button row (the `<div className="flex gap-2.5 mt-3">` containing 저장/승인) with this block, which keeps 저장, keeps/guards 승인, adds 승인 취소 (when approved), and adds the three target buttons:
```tsx
      <div className="flex flex-wrap items-center gap-2.5 mt-3">
        <button
          className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white disabled:opacity-50"
          disabled={busy || !dirty}
          onClick={() => run(() => props.onSave(props.item.itemId, korean))}
        >
          저장
        </button>
        {props.item.status === "approved" ? (
          <button
            className="px-3.5 py-1.5 rounded-md border border-neutral-300 bg-white disabled:opacity-50"
            disabled={busy}
            onClick={() => run(() => props.onUnapprove(props.item.itemId))}
          >
            승인 취소
          </button>
        ) : (
          <button
            className="px-3.5 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-50"
            disabled={busy || dirty}
            onClick={() => run(() => props.onApprove(props.item.itemId))}
          >
            승인 ✓
          </button>
        )}
        <span className="mx-1 h-5 w-px bg-neutral-200" />
        {(["local", "google", "lark"] as const).map((t) => {
          const label = t === "local" ? "로컬 저장" : t === "google" ? "구글 클라우드" : "라크 클라우드";
          const usable = props.availableTargets.includes(t);
          return (
            <button
              key={t}
              className={`px-3 py-1.5 rounded-md border text-sm ${usable ? "border-neutral-300 bg-white text-neutral-900" : "border-neutral-200 bg-neutral-50 text-neutral-300"} disabled:opacity-50`}
              disabled={busy || !usable}
              onClick={() => run(() => props.onPublish(props.item.itemId, t))}
            >
              {label}
            </button>
          );
        })}
      </div>
```

- [ ] **Step 4: Typecheck + build**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed (no reference to the deleted `PublishBar`, `api.config`, or `api.publish`).

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/App.tsx web/src/components/TranslationDetail.tsx
git commit -m "feat(web): per-item/per-target publish + unapprove in the detail pane; drop PublishBar"
```

---

### Task 5: Frontend polish — itemId → X link, font bump

**Files:**
- Modify: `web/src/components/TranslationList.tsx`, `web/src/components/TranslationDetail.tsx` (itemId link)
- Modify: `web/src/App.tsx`, `web/src/components/TranslationList.tsx`, `web/src/components/TranslationDetail.tsx`, `web/src/components/RenderingList.tsx`, `web/src/components/RenderingDetail.tsx` (font sizes)

**Interfaces:** none consumed downstream.

- [ ] **Step 1: itemId → X link helper + use**

Add a small helper to `web/src/types.ts`:
```ts
/** The original tweet URL for an `x:<id>` item, else null (lark items have no public URL). */
export const itemUrl = (itemId: string): string | null =>
  itemId.startsWith("x:") ? `https://x.com/i/status/${itemId.slice(2)}` : null;
```
In `web/src/components/TranslationDetail.tsx`, import `itemUrl` and render the id as a link when it has one — replace `<code className="text-sm">{props.item.itemId}</code>` with:
```tsx
        {itemUrl(props.item.itemId) ? (
          <a className="text-sm text-indigo-600 hover:underline" href={itemUrl(props.item.itemId)!} target="_blank" rel="noreferrer">
            <code>{props.item.itemId}</code>
          </a>
        ) : (
          <code className="text-sm">{props.item.itemId}</code>
        )}
```
In `web/src/components/TranslationList.tsx`, import `itemUrl` and wrap the id span the same way (the `<span className="text-xs text-neutral-600 truncate">{t.itemId}</span>`), stopping row-click propagation on the link so opening the tweet doesn't also select the row:
```tsx
              {itemUrl(t.itemId) ? (
                <a className="text-xs text-neutral-600 truncate hover:underline hover:text-indigo-600" href={itemUrl(t.itemId)!} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                  {t.itemId}
                </a>
              ) : (
                <span className="text-xs text-neutral-600 truncate">{t.itemId}</span>
              )}
```

- [ ] **Step 2: bump the font sizes**

Raise the dashboard's small text one notch so it reads comfortably, without changing layout structure. Apply these class substitutions across the five component files (`App.tsx`, `TranslationList.tsx`, `TranslationDetail.tsx`, `RenderingList.tsx`, `RenderingDetail.tsx`):
- `text-[11px]` → `text-xs`
- body/label `text-xs` → `text-sm`
- primary body `text-sm` (the source text, the Korean textarea, list item labels) → `text-base`

Find them with `grep -rn "text-\[11px\]\|text-xs\|text-sm" web/src`. Leave the header title and already-`text-base`+ sizes as they are; keep headings visually larger than body. Do not touch the funnel/status line if it becomes cramped — `text-xs` there is fine (raise only if it still fits).

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/App.tsx web/src/components/TranslationList.tsx web/src/components/TranslationDetail.tsx web/src/components/RenderingList.tsx web/src/components/RenderingDetail.tsx
git commit -m "feat(web): link x: items to the tweet and enlarge the font scale"
```

---

### Task 6: Whole-branch verification + PR

**Files:** none modified.

- [ ] **Step 1: Full verification**

Run:
```bash
pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web
```
Expected: all pass. Record the backend test count.

- [ ] **Step 2: Visual smoke check**

Run `pnpm serve`, open `http://localhost:5757`, and confirm: no header PublishBar and the mode badge is clearly legible; the detail pane shows 저장 / (승인 or 승인 취소) / 로컬 저장 / 구글 클라우드 / 라크 클라우드, with only the usable targets enabled (in local mode: only 로컬 저장); clicking 로컬 저장 publishes the item and its 발행 상태 link appears/updates; 승인 취소 reverts an approved item; an `x:` itemId links to the tweet; fonts are larger; and switching 1차/2차 no longer shifts. Stop the server afterward.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/dashboard-v2
gh pr create --title "feat(web): dashboard v2 — per-item/per-target publish, unapprove, polish" --body "$(cat <<'EOF'
Reworks the dashboard's publishing UX and applies the polish from the #45 review.

- **Per-item, per-target publish** in the detail pane — 로컬 저장 / 구글 클라우드 / 라크 클라우드, each publishing that one item to that target (`PublishTranslations.run({ itemId })` + a new `POST /api/translations/:id/publish`). Only usable targets enable, from a new `availableTargets` on `GET /api/status` (local always; google/lark only in cloud mode with the credentials configured).
- **승인 취소** (un-approve) — `POST /api/translations/:id/unapprove`, reusing `SaveTranslation`.
- **Removed the header PublishBar** (and the global `POST /api/publish` route + `buildPublisher`) — batch publish stays in `pnpm drive:publish`. This also removes the 1차/2차 **vertical shift** (the bar rendered only in 1차).
- **Mode badge contrast** fixed; **x: items link** to the tweet; **fonts enlarged**; **web fonts** now serve with `font/*` MIME.

No new use-case/port, no runtime mode toggle, backend stays `zod`-only. Verified live via playwright.

Spec: `docs/superpowers/specs/2026-07-21-dashboard-v2-design.md`
Plan: `docs/superpowers/plans/2026-07-21-dashboard-v2.md`
EOF
)"
```

- [ ] **Step 4: Wait for CI**

Run: `gh pr checks --watch`
Expected: the required `test` check passes.
