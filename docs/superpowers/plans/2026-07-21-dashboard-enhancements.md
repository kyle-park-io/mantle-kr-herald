# Review Dashboard Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the filter layout shift, apply the Pretendard font, and add three mode-aware reads (header mode badge, pipeline status line, published-artifact links) to the local review dashboard.

**Architecture:** Two new thin JSON read endpoints (`GET /api/status`, `GET /api/publish/state`) whose data is composed in `serve.ts` and injected through `ApiDeps`, plus a static-style `GET /api/publish/local/<path>` route in `HttpServer` that serves the local markdown with a traversal guard. The React frontend consumes them; the font and CSS fix are frontend-only.

**Tech Stack:** TypeScript (ESM, hexagonal), `zod`-only Node backend, `node:http` server, React + Vite + Tailwind v4 frontend (build-time devDeps only), vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-dashboard-enhancements-design.md`

## Global Constraints

- Runtime dependencies of the **Node backend** stay **`zod`-only**. The font (`pretendard`) is a **build-time devDependency** of the frontend — allowed, since Vite bundles it into `web/dist` and the backend never imports it.
- Code and comments in **English**; user-visible UI strings stay **Korean** (`발행 상태`, `수집`, etc.).
- `HttpServer` keeps its split: `/api/*` → `handleApi` (JSON), everything else static. The one exception this plan adds is the `/api/publish/local/<path>` file route, handled in `HttpServer` **before** the JSON branch (it must return `text/markdown`, not JSON).
- **Writes/behaviour unchanged.** These are read-only additions plus a font and a CSS fix. No change to publish/approve/edit flows, CLIs, or `output/` layout.
- **`main` is branch-protected.** Work on `feat/dashboard-enhancements` (already created; the spec commit is on it). Integration is by PR.
- Verification: `pnpm test` + `pnpm typecheck` for backend tasks; `pnpm typecheck:web` + `pnpm build:web` for frontend tasks; the whole-branch run also does `pnpm serve` for a visual check.

### Ledger field meaning (used by Tasks 1 and 4)

`LocalFileUploader.upload` returns `{ id: <rootDir-relative path, e.g. "approved/<name>.md">, name: <bare filename> }`; `PublishTranslations` records `remoteId: result.id`, `fileName: result.name`. So a **local** ledger row's **`remoteId` is the relative path to open**; a **google/lark** row's `url` is the openable `webViewLink`.

---

### Task 1: Two JSON read endpoints — `GET /api/status` and `GET /api/publish/state`

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts` (types, `ApiDeps`, two routes)
- Modify: `src/cli/serve.ts` (compose `loadStatus` + `loadPublishState`, add to deps)
- Test: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `syncSummary` (`src/status/sync.ts`), `renderApproved`/`renderReview` (`src/domain/publish/renderers.ts`), `CompositeContentSource`/`XContentSource`/`LarkContentSource` (`src/adapters/content/`), `JsonPublishStore.listEntries()` (already in `serve.ts`), `StorageMode` (`src/storage/mode.ts`).
- Produces (exported from `apiHandlers.ts`):
  - `interface StatusView { storageMode: StorageMode; funnel: { collected: number; translated: number; converted: number; rendered: number; published: number }; sync: { published: number; unsynced: number; stale: number } }`
  - `interface PublishStateRow { itemId: string; status: string; target: string; url?: string; remoteId?: string; fileName?: string }`
  - `ApiDeps` gains `loadStatus: () => Promise<StatusView>` and `loadPublishState: () => Promise<PublishStateRow[]>`.

- [ ] **Step 1: Write the failing tests**

In `tests/adapters/web/apiHandlers.test.ts`, first extend the `makeDeps` return object (the final `return { translationStore, saveTranslation, buildPublisher, storageMode: "cloud", formattingStore, conversionStore, saveRendering, approveRendering };`) to also include:

```ts
    loadStatus: async () => ({
      storageMode: "cloud" as const,
      funnel: { collected: 5, translated: 3, converted: 2, rendered: 4, published: 1 },
      sync: { published: 1, unsynced: 2, stale: 0 },
    }),
    loadPublishState: async () => [
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ],
```

Then append these tests at the end of the `describe("handleApi", ...)` block:

```ts
  it("GET /api/status returns the storage mode, funnel and sync counts", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/status", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      storageMode: "cloud",
      funnel: { collected: 5, translated: 3, converted: 2, rendered: 4, published: 1 },
      sync: { published: 1, unsynced: 2, stale: 0 },
    });
  });

  it("GET /api/publish/state returns the trimmed ledger rows", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/publish/state", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      { itemId: "x:1", status: "approved", target: "google", url: "https://drive/x1" },
      { itemId: "x:2", status: "approved", target: "local", remoteId: "approved/2026-x2.md", fileName: "2026-x2.md" },
    ]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — both new routes 404 (`{ error: "not found" }`), and `pnpm typecheck` would reject the unknown `loadStatus`/`loadPublishState` keys (vitest strips types, so at runtime it is the 404s that fail).

- [ ] **Step 3: Extend `ApiDeps` and add the types + routes**

In `src/adapters/web/apiHandlers.ts`, add the import:

```ts
import type { StorageMode } from "../../storage/mode";
```

Add the two interfaces above `export interface ApiResult`:

```ts
export interface StatusView {
  storageMode: StorageMode;
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { published: number; unsynced: number; stale: number };
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
}
```

Add to the `ApiDeps` interface (after `storageMode: StorageMode;`):

```ts
  loadStatus: () => Promise<StatusView>;
  loadPublishState: () => Promise<PublishStateRow[]>;
```

In `handleApi`, immediately after the `GET /api/config` route, add:

```ts
  if (method === "GET" && segments.length === 2 && segments[1] === "status") {
    return { status: 200, json: await deps.loadStatus() };
  }
  if (method === "GET" && segments.length === 3 && segments[1] === "publish" && segments[2] === "state") {
    return { status: 200, json: await deps.loadPublishState() };
  }
```

(The `POST /api/publish` route checks `segments.length === 2 && segments[1] === "publish"`, so the 3-segment `publish/state` GET does not collide.)

- [ ] **Step 4: Compose the deps in `serve.ts`**

In `src/cli/serve.ts`, add imports:

```ts
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { syncSummary } from "../status/sync";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import type { StatusView, PublishStateRow } from "../adapters/web/apiHandlers";
```

After the existing store constructions (before the `deps` object), add:

```ts
const contentSource = new CompositeContentSource([
  new XContentSource(paths.xItems),
  new LarkContentSource(paths.larkItems),
]);

const loadStatus = async (): Promise<StatusView> => {
  const [collected, translations, variants, renderings, entries] = await Promise.all([
    contentSource.loadPending(new Set()),
    translationStore.loadAll(),
    conversionStore.loadAll(),
    formattingStore.loadAll(),
    publishStore.listEntries(),
  ]);
  const sync = syncSummary({
    translations,
    entries,
    render: (t) => (t.status === "approved" ? renderApproved(t) : renderReview(t)),
  });
  return {
    storageMode,
    funnel: {
      collected: collected.length,
      translated: translations.length,
      converted: variants.length,
      rendered: renderings.length,
      published: entries.length,
    },
    sync,
  };
};

const loadPublishState = async (): Promise<PublishStateRow[]> =>
  (await publishStore.listEntries()).map((e) => ({
    itemId: e.itemId,
    status: e.status,
    target: e.target,
    url: e.url,
    remoteId: e.remoteId,
    fileName: e.fileName,
  }));
```

Add `loadStatus,` and `loadPublishState,` to the `deps: ApiDeps` object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/apiHandlers.ts src/cli/serve.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat(web): add GET /api/status and GET /api/publish/state read endpoints"
```

---

### Task 2: Local markdown file route in `HttpServer`

**Files:**
- Modify: `src/adapters/web/HttpServer.ts` (opts, MIME, the file branch)
- Modify: `src/cli/serve.ts` (pass `localPublishDir`)
- Test: `tests/adapters/web/httpServer.test.ts`

**Interfaces:**
- Consumes: `paths.publishLocalDir` (`src/paths.ts`).
- Produces: `startServer(deps, { port, staticDir, localPublishDir })` — the opts object gains `localPublishDir: string`. New route `GET /api/publish/local/<relpath>` → `200 text/markdown` or `404`.

- [ ] **Step 1: Write the failing tests**

The test harness in `tests/adapters/web/httpServer.test.ts` builds `ApiDeps` via `fakeDeps()`; first add the two new deps to it (so the file typechecks after Task 1). In `fakeDeps()`'s returned object add:

```ts
    loadStatus: async () => ({ storageMode: "cloud" as const, funnel: { collected: 0, translated: 0, converted: 0, rendered: 0, published: 0 }, sync: { published: 0, unsynced: 0, stale: 0 } }),
    loadPublishState: async () => [],
```

Change the `start` helper to create and pass a local-publish dir, and return it:

```ts
async function start(staticDir: string, localPublishDir = staticDir) {
  const server = startServer(fakeDeps(), { port: 0, staticDir, localPublishDir });
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
```

Append these tests inside `describe("startServer", ...)`:

```ts
  it("serves a local publish file as text/markdown", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    await mkdir(join(pubDir, "approved"), { recursive: true });
    await writeFile(join(pubDir, "approved", "doc.md"), "# 발행본\n본문");
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/approved/doc.md`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("# 발행본\n본문");
  });

  it("returns 404 for a traversal attempt, reading nothing outside the root", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>x</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/../../etc/passwd`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a missing local publish file (not the SPA fallback)", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(staticDir, "index.html"), "<!doctype html><title>dash</title>");
    const pubDir = await mkdtemp(join(tmpdir(), "pub-"));
    const base = await start(staticDir, pubDir);

    const res = await fetch(`${base}/api/publish/local/nope.md`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("dash");
  });
```

Add `mkdir` to the existing `node:fs/promises` import at the top of the test file (it currently imports `mkdtemp, writeFile`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/adapters/web/httpServer.test.ts`
Expected: FAIL — `startServer`'s opts type has no `localPublishDir` (typecheck) and `/api/publish/local/...` currently falls into the `/api/` JSON branch → 404 JSON / SPA fallback, so the assertions fail.

- [ ] **Step 3: Implement the route**

In `src/adapters/web/HttpServer.ts`:

Change the `node:path` import to add `resolve` and `sep`:

```ts
import { join, normalize, extname, resolve, sep } from "node:path";
```

Add `.md` to the `MIME` map:

```ts
  ".md": "text/markdown; charset=utf-8",
```

Change the `startServer` signature's opts type to include `localPublishDir`:

```ts
export function startServer(deps: ApiDeps, opts: { port: number; staticDir: string; localPublishDir: string }): Server {
```

Inside the `createServer` handler, **before** the `if (url.pathname.startsWith("/api/"))` branch, add:

```ts
      if (url.pathname.startsWith("/api/publish/local/")) {
        const rel = normalize(decodeURIComponent(url.pathname.slice("/api/publish/local/".length)))
          .replace(/^(\.\.[/\\])+/, "")
          .replace(/^[/\\]+/, "");
        const filePath = join(opts.localPublishDir, rel);
        // Defense in depth: the resolved path must stay under the publish-local root.
        if (resolve(filePath) !== resolve(opts.localPublishDir) && !resolve(filePath).startsWith(resolve(opts.localPublishDir) + sep)) {
          res.writeHead(404).end();
          return;
        }
        try {
          const data = await readFile(filePath);
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" }).end(data);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }
```

- [ ] **Step 4: Pass `localPublishDir` from `serve.ts`**

In `src/cli/serve.ts`, change the `startServer` call to include the dir:

```ts
startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/HttpServer.ts src/cli/serve.ts tests/adapters/web/httpServer.test.ts
git commit -m "feat(web): serve local publish files as text/markdown with a traversal guard"
```

---

### Task 3: Frontend — types, API client, mode badge, status line

**Files:**
- Modify: `web/src/types.ts` (add `AppStatus`, `PublishStateRow`)
- Modify: `web/src/api.ts` (add `status`, `publishState`)
- Modify: `web/src/App.tsx` (fetch status, render badge + status line)

**Interfaces:**
- Consumes: `GET /api/status`, `GET /api/publish/state` (Task 1).
- Produces: `api.status()`, `api.publishState()`; `AppStatus`, `PublishStateRow` types (used by Task 4).

- [ ] **Step 1: Add the types**

In `web/src/types.ts`, append (the file already defines `StorageMode`):

```ts
export interface AppStatus {
  storageMode: StorageMode;
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { published: number; unsynced: number; stale: number };
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
}
```

- [ ] **Step 2: Add the API calls**

In `web/src/api.ts`, extend the type import to include the two new types, e.g.:

```ts
import type { Translation, PublishResult, Rendering, ConversionType, Channel, AppConfig, AppStatus, PublishStateRow } from "./types";
```

Add these two entries to the `api` object:

```ts
  status: () => fetch("/api/status").then((r) => json<AppStatus>(r)),
  publishState: () => fetch("/api/publish/state").then((r) => json<PublishStateRow[]>(r)),
```

- [ ] **Step 3: Fetch status and render the badge + line in `App.tsx`**

In `web/src/App.tsx`, add `AppStatus` and `PublishStateRow` to the `./types` import, then inside `App()` add state and a fetch:

```tsx
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [publishRows, setPublishRows] = useState<PublishStateRow[]>([]);

  const refreshStatus = () => {
    api.status().then(setStatus).catch(() => setStatus(null));
    api.publishState().then(setPublishRows).catch(() => setPublishRows([]));
  };
  useEffect(() => {
    refreshStatus();
  }, []);
```

Call `refreshStatus()` at the end of both `onApprove` (after `await refresh()`) and the `PublishBar` flow is separate — leave `PublishBar` as is; a manual browser reload covers a fresh publish, and `onApprove` covers status changes.

Replace the `<header>` block so it carries the mode badge and, below the top row, the status line. Use this header:

```tsx
      <header className="bg-neutral-950 text-white">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 font-semibold">
          <div className="flex items-center gap-3">
            <span>Mantle KR — Review</span>
            {status && (
              <span
                className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${status.storageMode === "cloud" ? "bg-green-500/20 text-green-300" : "bg-amber-500/20 text-amber-300"}`}
              >
                {status.storageMode}
              </span>
            )}
            <nav className="flex gap-1">
              <button className={tab(mode === "translations")} onClick={() => switchMode("translations")}>1차 검수 (번역)</button>
              <button className={tab(mode === "renderings")} onClick={() => switchMode("renderings")}>2차 검수 (채널)</button>
            </nav>
          </div>
          {mode === "translations" && <PublishBar />}
        </div>
        {status && (
          <div className="px-4 pb-1.5 text-[11px] text-neutral-300 font-normal">
            수집 {status.funnel.collected} → 번역 {status.funnel.translated} → 변환 {status.funnel.converted} → 렌더 {status.funnel.rendered} → 발행 {status.funnel.published}
            <span className="ml-3">
              {status.sync.unsynced > 0 || status.sync.stale > 0 ? "⚠ " : ""}
              sync: {status.sync.published} published{status.sync.unsynced > 0 ? ` · ${status.sync.unsynced} unsynced` : ""}{status.sync.stale > 0 ? ` · ${status.sync.stale} stale` : ""}
            </span>
          </div>
        )}
      </header>
```

- [ ] **Step 4: Typecheck and build**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/App.tsx
git commit -m "feat(web): header mode badge and pipeline status line"
```

---

### Task 4: Frontend — published-artifact links in the detail pane

**Files:**
- Modify: `web/src/App.tsx` (pass matching rows to `TranslationDetail`)
- Modify: `web/src/components/TranslationDetail.tsx` (render the 발행 상태 block)

**Interfaces:**
- Consumes: `publishRows: PublishStateRow[]` state from Task 3.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Pass matching rows into `TranslationDetail`**

In `web/src/App.tsx`, where `TranslationDetail` is rendered, pass the rows for the selected item:

```tsx
                <TranslationDetail
                  item={selected}
                  publishRows={publishRows.filter((r) => r.itemId === selected.itemId)}
                  onSave={onSave}
                  onApprove={onApprove}
                  onDirtyChange={setDirty}
                />
```

- [ ] **Step 2: Render the block in `TranslationDetail`**

In `web/src/components/TranslationDetail.tsx`, add `PublishStateRow` to the `../types` import, add `publishRows: PublishStateRow[]` to the component's props type, and render a block (place it near the bottom of the detail, after the existing content — match the file's existing markup style):

```tsx
      <div className="mt-6 border-t border-neutral-200 pt-3">
        <h3 className="text-xs font-semibold text-neutral-500 mb-1.5">발행 상태</h3>
        {publishRows.length === 0 ? (
          <p className="text-xs text-neutral-400">아직 발행되지 않음</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {publishRows.map((r) => (
              <li key={`${r.status}:${r.target}`} className="flex items-center gap-2 text-xs">
                <span className="text-neutral-500">{r.status} · {r.target}</span>
                {r.target === "local" && r.remoteId ? (
                  <a className="text-indigo-600 hover:underline" href={`/api/publish/local/${r.remoteId}`} target="_blank" rel="noreferrer">열기</a>
                ) : r.url ? (
                  <a className="text-indigo-600 hover:underline" href={r.url} target="_blank" rel="noreferrer">Drive에서 열기</a>
                ) : (
                  <span className="text-neutral-400">링크 없음</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
```

- [ ] **Step 3: Typecheck and build**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/TranslationDetail.tsx
git commit -m "feat(web): show published-artifact links (Drive / local) in the detail pane"
```

---

### Task 5: Pretendard font + scrollbar-gutter fix

**Files:**
- Modify: `package.json` (add `pretendard` devDependency)
- Modify: `web/src/styles.css` (import font, set default family)
- Modify: `web/src/App.tsx` and any other `overflow-y-auto` container (add `scrollbar-gutter: stable`)

**Interfaces:** none consumed downstream.

- [ ] **Step 1: Install the font package**

Run:

```bash
pnpm add -D pretendard
```

Expected: `pretendard` appears under `devDependencies` in `package.json`; `pnpm-lock.yaml` updates. (Build-time only — the Node backend never imports it.)

- [ ] **Step 2: Import the font and set the default family**

Confirm the CSS path inside the installed package (it varies by version):

```bash
ls node_modules/pretendard/dist/web/variable/ node_modules/pretendard/dist/web/static/ 2>/dev/null
```

Then edit `web/src/styles.css` to (using the variable stylesheet if present, else the static one):

```css
@import "tailwindcss";
@import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";

@theme {
  --default-font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif;
}
```

If the `variable` subset file is not present in the installed version, use the path that `ls` showed (e.g. `pretendard/dist/web/static/pretendard.css` and family `Pretendard`). Verify the exact filename before committing.

- [ ] **Step 3: Add `scrollbar-gutter: stable` to the scroll containers**

Find every scroll container in the dashboard:

```bash
grep -rn "overflow-y-auto" web/src
```

To each element that has `overflow-y-auto` (in `App.tsx`: the `<aside className="w-72 …">` and the `<section className="flex-1 p-6 …">`; plus any in `RenderingsView.tsx`/`RenderingList.tsx`), append the Tailwind arbitrary property `[scrollbar-gutter:stable]` to its `className`. Example for the aside:

```tsx
            <aside className="w-72 border-r border-neutral-200 overflow-y-auto [scrollbar-gutter:stable]">
```

- [ ] **Step 4: Build**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed; the built CSS in `web/dist` includes the Pretendard `@font-face` (bundled, no CDN).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml web/src/styles.css web/src/App.tsx web/src/components/RenderingsView.tsx web/src/components/RenderingList.tsx
git commit -m "feat(web): apply Pretendard font and stop the filter scrollbar shift"
```

(Only add the component files that actually changed — check `git status` first.)

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

Run `pnpm serve`, open `http://localhost:5757`, and confirm: the font renders as Pretendard; the header shows the `local`/`cloud` badge and the funnel line; selecting a published translation shows the 발행 상태 block with a working link (local file opens as markdown, or a Drive link opens); and switching the list filter back and forth no longer shifts the layout. Stop the server afterward.

**On the filter shift specifically:** `scrollbar-gutter: stable` (Task 5) is the hypothesis for the cause (the scroll container's gutter toggling as the filtered list changes length). This visual check is its confirmation. If the layout still shifts, the cause was something else — diagnose it on the running app (systematic-debugging) and fix the real cause before opening the PR; do not ship the PR with the shift unaddressed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/dashboard-enhancements
gh pr create --title "feat(web): dashboard polish — mode badge, status line, published links, Pretendard, filter fix" --body "$(cat <<'EOF'
Enhances the local review dashboard without changing any pipeline behaviour:

- **Mode badge + pipeline status line** in the header, from a new `GET /api/status` (funnel + sync + storage mode, reusing `src/status/`).
- **Published-artifact links** in the 1차 detail pane, from a new `GET /api/publish/state`; a cloud row opens its Drive `webViewLink`, a local row opens `GET /api/publish/local/<remoteId>` — served as `text/markdown` by `HttpServer` with a traversal guard.
- **Pretendard** font, self-hosted (build-time devDependency, no CDN).
- **Filter layout shift fixed** with `scrollbar-gutter: stable` on the scroll containers.

Backend stays `zod`-only (the font is a frontend build-time devDep). Read-only additions — no change to publish/approve/edit, the CLIs, or `output/`. Impressions and markdown rendering deferred.

Spec: `docs/superpowers/specs/2026-07-21-dashboard-enhancements-design.md`
Plan: `docs/superpowers/plans/2026-07-21-dashboard-enhancements.md`
EOF
)"
```

- [ ] **Step 4: Wait for CI**

Run: `gh pr checks --watch`
Expected: the required `test` check passes.
