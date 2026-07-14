# Review Dashboard (Subsystem E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web dashboard (`pnpm serve` → localhost) for the Mantle KR team to list, view, edit, approve, and publish agent-produced Korean translations.

**Architecture:** A `node:http` server serves a built React app plus a JSON API. The API is a thin adapter over existing app use-cases (`TranslationStore`, `SaveTranslation`, `PublishTranslations`) — no new domain logic. The React frontend lives isolated in `web/` and is built by Vite to a static bundle.

**Tech Stack:** Backend — TypeScript ESM, `node:http`, `tsx`, `zod` (existing). Frontend — React 18, Vite 5, TypeScript, isolated in `web/`.

## Global Constraints

- Backend: TypeScript ESM, `moduleResolution: bundler` — **no `.js` import extensions**.
- Backend runtime dependencies: **`zod` only**. Native `fetch`, `node:*` built-ins. React/Vite are **build-time** (devDependencies).
- Code and comments in **English**; UI copy in **Korean**.
- Reuse existing `domain` / `app` — the web layer adds **no domain logic**.
- Spec: `docs/superpowers/specs/2026-07-15-review-dashboard-design.md`.
- Existing interfaces (verbatim):
  - `interface Translation { itemId: string; source: "x" | "lark"; sourceText: string; koreanText: string; status: "translated" | "approved"; translatedAt: string; approvedAt?: string }`
  - `TranslationStore { loadAll(): Promise<Translation[]>; upsert(t): Promise<void>; listTranslatedIds(): Promise<Set<string>> }`
  - `new SaveTranslation(translationStore, fewShotStore, now?)`, `run({itemId, source, sourceText, koreanText, approve}): Promise<{itemId, promoted}>`
  - `new PublishTranslations(translationStore, uploaders[], publishStore)`, `run(): Promise<{uploaded, failed, byDrive}>`
  - `JsonTranslationStore("output/translations")`, `JsonPublishStore("output/publish")`, `JsonFewShotStore("translation")`
  - `loadGoogleAuthConfig()`, `createGoogleAuth(cfg)`, `loadGoogleDriveConfig(): {reviewFolderId, approvedFolderId}`, `new GoogleDriveUploader(auth, {review, approved})`
  - `loadLarkDriveConfig()`, `new LarkAuth(new HttpClient(baseUrl), appId, appSecret)`, `new LarkDriveUploader(auth, baseUrl, {review, approved})`
- Server port: `Number(process.env.PORT) || 5757`.

---

## File structure

```
src/adapters/web/
  apiHandlers.ts     # handleApi(deps, method, path, body) -> {status, json}; pure routing over use-cases (unit-tested)
  HttpServer.ts      # startServer(deps, {port, staticDir}) : node:http — parse request, dispatch /api to handleApi, else serve static
src/cli/serve.ts     # composition root: build deps (stores, SaveTranslation, publisher factory), start server, print URL
web/
  package.json       # frontend deps (react, react-dom, vite, @vitejs/plugin-react, typescript)
  vite.config.ts     # react plugin + /api proxy to :5757 (dev) + build outDir dist
  tsconfig.json      # frontend TS config
  index.html
  src/
    main.tsx
    App.tsx          # top-level state: list + selection + filter + publish
    api.ts           # typed fetch wrappers
    types.ts         # Translation type mirror
    components/
      TranslationList.tsx
      TranslationDetail.tsx
      PublishBar.tsx
    styles.css
tests/adapters/web/
  apiHandlers.test.ts
package.json         # add scripts: serve, dev:web, build:web
```

---

### Task 1: API handlers (`handleApi`)

**Files:**
- Create: `src/adapters/web/apiHandlers.ts`
- Test: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `TranslationStore.loadAll`, `SaveTranslation.run`, `PublishTranslations.run` (see Global Constraints).
- Produces:
  - `interface ApiResult { status: number; json: unknown }`
  - `interface ApiDeps { translationStore: TranslationStore; saveTranslation: SaveTranslation; buildPublisher: (target: string) => Promise<PublishTranslations> }`
  - `async function handleApi(deps: ApiDeps, method: string, path: string, body: unknown): Promise<ApiResult>`

Routing:
- `GET /api/translations` → 200, `Translation[]`.
- `PUT /api/translations/:id` (id url-encoded) → validate `body.koreanText` is a non-empty string (else 400); load existing by itemId (404 if absent); `saveTranslation.run({itemId, source, sourceText: existing.sourceText, koreanText, approve: false})`; return 200 with the reloaded `Translation`.
- `POST /api/translations/:id/approve` → load existing (404 if absent); `saveTranslation.run({...existing fields, koreanText: existing.koreanText, approve: true})`; return 200 with reloaded `Translation`.
- `POST /api/publish` → `target = (body?.target as string) || "google"`; `const pub = await deps.buildPublisher(target); return { status: 200, json: await pub.run() }`.
- anything else → 404 `{ error: "not found" }`.
- Editing/approving reload the item after `run` (SaveTranslation returns only `{itemId, promoted}`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/adapters/web/apiHandlers.test.ts
import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { Translation } from "../../../src/domain/translation/models";

function tr(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "src", koreanText: "ko", status: "translated", translatedAt: "t", ...over };
}

function makeDeps(list: Translation[]): ApiDeps {
  const state = { list: [...list] };
  const translationStore = {
    loadAll: async () => state.list,
    upsert: async (t: Translation) => {
      state.list = [...state.list.filter((x) => x.itemId !== t.itemId), t];
    },
    listTranslatedIds: async () => new Set(state.list.map((x) => x.itemId)),
  };
  const saveTranslation = {
    run: async (input: { itemId: string; source: "x" | "lark"; sourceText: string; koreanText: string; approve: boolean }) => {
      await translationStore.upsert(tr({ itemId: input.itemId, source: input.source, sourceText: input.sourceText, koreanText: input.koreanText, status: input.approve ? "approved" : "translated", approvedAt: input.approve ? "a" : undefined }));
      return { itemId: input.itemId, promoted: input.approve };
    },
  } as unknown as ApiDeps["saveTranslation"];
  const buildPublisher = async () =>
    ({ run: async () => ({ uploaded: 2, failed: 0, byDrive: { google: 2 } }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>;
  return { translationStore, saveTranslation, buildPublisher };
}

describe("handleApi", () => {
  it("GET /api/translations returns the list", async () => {
    const d = makeDeps([tr({ itemId: "x:1" }), tr({ itemId: "x:2" })]);
    const res = await handleApi(d, "GET", "/api/translations", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation[]).map((t) => t.itemId)).toEqual(["x:1", "x:2"]);
  });

  it("PUT edits koreanText and returns the updated (still translated) item", async () => {
    const d = makeDeps([tr({ itemId: "x:1", koreanText: "old" })]);
    const res = await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "새 번역" });
    expect(res.status).toBe(200);
    expect((res.json as Translation).koreanText).toBe("새 번역");
    expect((res.json as Translation).status).toBe("translated");
  });

  it("PUT with empty koreanText is 400", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    expect((await handleApi(d, "PUT", "/api/translations/x%3A1", { koreanText: "" })).status).toBe(400);
  });

  it("PUT unknown id is 404", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    expect((await handleApi(d, "PUT", "/api/translations/x%3A9", { koreanText: "x" })).status).toBe(404);
  });

  it("POST approve promotes to approved", async () => {
    const d = makeDeps([tr({ itemId: "x:1" })]);
    const res = await handleApi(d, "POST", "/api/translations/x%3A1/approve", undefined);
    expect(res.status).toBe(200);
    expect((res.json as Translation).status).toBe("approved");
  });

  it("POST /api/publish runs the publisher for the target", async () => {
    const d = makeDeps([tr()]);
    const res = await handleApi(d, "POST", "/api/publish", { target: "google" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ uploaded: 2, failed: 0, byDrive: { google: 2 } });
  });

  it("unknown route is 404", async () => {
    const d = makeDeps([]);
    expect((await handleApi(d, "GET", "/api/nope", undefined)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — cannot find module `apiHandlers`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/adapters/web/apiHandlers.ts
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import type { SaveTranslation } from "../../app/SaveTranslation";
import type { PublishTranslations } from "../../app/PublishTranslations";

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  buildPublisher: (target: string) => Promise<PublishTranslations>;
}

async function findById(store: TranslationStore, id: string): Promise<Translation | undefined> {
  return (await store.loadAll()).find((t) => t.itemId === id);
}

export async function handleApi(deps: ApiDeps, method: string, path: string, body: unknown): Promise<ApiResult> {
  const segments = path.split("/").filter(Boolean); // ["api", "translations", ...]
  if (segments[0] !== "api") return { status: 404, json: { error: "not found" } };

  if (method === "GET" && segments.length === 2 && segments[1] === "translations") {
    return { status: 200, json: await deps.translationStore.loadAll() };
  }

  if (segments[1] === "translations" && segments.length >= 3) {
    const id = decodeURIComponent(segments[2]);
    const existing = await findById(deps.translationStore, id);

    if (method === "PUT" && segments.length === 3) {
      const koreanText = (body as { koreanText?: unknown })?.koreanText;
      if (typeof koreanText !== "string" || koreanText.trim() === "") {
        return { status: 400, json: { error: "koreanText required" } };
      }
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText, approve: false });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }

    if (method === "POST" && segments.length === 4 && segments[3] === "approve") {
      if (!existing) return { status: 404, json: { error: "not found" } };
      await deps.saveTranslation.run({ itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText, koreanText: existing.koreanText, approve: true });
      return { status: 200, json: await findById(deps.translationStore, id) };
    }
  }

  if (method === "POST" && segments.length === 2 && segments[1] === "publish") {
    const target = (body as { target?: string })?.target || "google";
    const pub = await deps.buildPublisher(target);
    return { status: 200, json: await pub.run() };
  }

  return { status: 404, json: { error: "not found" } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/web/apiHandlers.test.ts` and `pnpm typecheck`
Expected: 7 passed; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat: review dashboard API handlers over existing use-cases"
```

---

### Task 2: HTTP server (`node:http`)

**Files:**
- Create: `src/adapters/web/HttpServer.ts`
- Test: `tests/adapters/web/httpServer.test.ts`

**Interfaces:**
- Consumes: `handleApi`, `ApiDeps` (Task 1).
- Produces: `function startServer(deps: ApiDeps, opts: { port: number; staticDir: string }): http.Server` — resolves `/api/*` via `handleApi`; serves files from `staticDir` (SPA fallback to `index.html`); JSON-parses request bodies; catches thrown errors → `500 { error }`.

- [ ] **Step 1: Write the failing test** (integration: start on ephemeral port, fetch)

```typescript
// tests/adapters/web/httpServer.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../../src/adapters/web/HttpServer";
import type { ApiDeps } from "../../../src/adapters/web/apiHandlers";

const servers: import("node:http").Server[] = [];
afterEach(() => servers.forEach((s) => s.close()));

function fakeDeps(): ApiDeps {
  return {
    translationStore: { loadAll: async () => [{ itemId: "x:1", source: "x", sourceText: "s", koreanText: "k", status: "translated", translatedAt: "t" }], upsert: async () => {}, listTranslatedIds: async () => new Set() },
    saveTranslation: { run: async () => ({ itemId: "x:1", promoted: false }) } as unknown as ApiDeps["saveTranslation"],
    buildPublisher: async () => ({ run: async () => ({ uploaded: 0, failed: 0, byDrive: {} }) }) as unknown as Awaited<ReturnType<ApiDeps["buildPublisher"]>>,
  };
}

async function start(staticDir: string) {
  const server = startServer(fakeDeps(), { port: 0, staticDir });
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("startServer", () => {
  it("serves the API as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const base = await start(dir);
    const res = await fetch(`${base}/api/translations`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { itemId: string }[])[0].itemId).toBe("x:1");
  });

  it("serves index.html for a non-API path (SPA fallback)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-"));
    await writeFile(join(dir, "index.html"), "<!doctype html><title>dash</title>");
    const base = await start(dir);
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain("dash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/web/httpServer.test.ts`
Expected: FAIL — cannot find module `HttpServer`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/adapters/web/HttpServer.ts
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { handleApi, type ApiDeps } from "./apiHandlers";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function startServer(deps: ApiDeps, opts: { port: number; staticDir: string }): Server {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
        const result = await handleApi(deps, req.method ?? "GET", url.pathname, body);
        res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(result.json));
        return;
      }
      // static: map path to a file under staticDir, default to index.html (SPA fallback)
      const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
      let filePath = join(opts.staticDir, rel);
      let data: Buffer;
      try {
        data = await readFile(filePath);
      } catch {
        filePath = join(opts.staticDir, "index.html");
        data = await readFile(filePath);
      }
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" }).end(data);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/web/httpServer.test.ts` and `pnpm typecheck`
Expected: 2 passed; typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/web/HttpServer.ts tests/adapters/web/httpServer.test.ts
git commit -m "feat: node:http server for the dashboard (API + static SPA)"
```

---

### Task 3: Composition root (`serve.ts`) + scripts

**Files:**
- Create: `src/cli/serve.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `startServer` (Task 2), `JsonTranslationStore`, `JsonPublishStore`, `JsonFewShotStore`, `SaveTranslation`, `PublishTranslations`, `GoogleDriveUploader`, `LarkDriveUploader`, and the config loaders / auth factory (Global Constraints).

- [ ] **Step 1: Write `serve.ts`** (composition root — verified by running, not a unit test)

```typescript
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { PublishTranslations } from "../app/PublishTranslations";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { HttpClient } from "../shared/http/HttpClient";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore("output/translations");
const publishStore = new JsonPublishStore("output/publish");
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore("translation"));

async function uploadersFor(target: string): Promise<DriveUploader[]> {
  const uploaders: DriveUploader[] = [];
  if (target === "google" || target === "both") {
    const g = loadGoogleDriveConfig();
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    uploaders.push(new GoogleDriveUploader(auth, { review: g.reviewFolderId, approved: g.approvedFolderId }));
  }
  if (target === "lark" || target === "both") {
    const l = loadLarkDriveConfig();
    const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
    uploaders.push(new LarkDriveUploader(auth, l.baseUrl, { review: l.reviewFolderToken, approved: l.approvedFolderToken }));
  }
  if (uploaders.length === 0) throw new Error(`Unknown publish target: ${target}`);
  return uploaders;
}

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  buildPublisher: async (target) => new PublishTranslations(translationStore, await uploadersFor(target), publishStore),
};

startServer(deps, { port, staticDir: join("web", "dist") });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);
```

- [ ] **Step 2: Add scripts to `package.json`**

Add to the `scripts` block (after `"drive:init"`):
```json
    "serve": "tsx --env-file-if-exists=.env src/cli/serve.ts",
    "dev:web": "vite --config web/vite.config.ts",
    "build:web": "vite build --config web/vite.config.ts",
```

- [ ] **Step 3: Verify it starts and serves the API**

Run: `pnpm typecheck` (exit 0), then:
```bash
PORT=5758 pnpm serve & sleep 2; curl -s localhost:5758/api/translations | head -c 120; echo; kill %1
```
Expected: JSON array printed (reads `output/translations/translations.json`; `[]` if empty), no crash. (The static 404s until `build:web` runs — expected.)

- [ ] **Step 4: Commit**

```bash
git add src/cli/serve.ts package.json
git commit -m "feat: pnpm serve — dashboard composition root + scripts"
```

---

### Task 4: Frontend scaffold + translation list

**Files:**
- Create: `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/types.ts`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/components/TranslationList.tsx`, `web/src/styles.css`
- Modify: `.gitignore` (add `web/dist/`, `web/node_modules/`)
- Modify root `package.json` devDependencies

**Interfaces:**
- Consumes: the JSON API from Tasks 1–3 (`GET /api/translations`, etc.).
- Produces: a buildable React app whose `App` fetches and lists translations.

- [ ] **Step 1: Add frontend devDependencies to root `package.json`**

In `devDependencies` add:
```json
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "vite": "^5.4.10",
    "@vitejs/plugin-react": "^4.3.3",
```
Then run `pnpm install`.

- [ ] **Step 2: Create the Vite/TS/HTML scaffold**

`web/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:5757" } },
});
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`web/index.html`:
```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mantle KR — Review</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/types.ts`:
```typescript
export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: "translated" | "approved";
  translatedAt: string;
  approvedAt?: string;
}
export interface PublishResult {
  uploaded: number;
  failed: number;
  byDrive: Record<string, number>;
}
```

`web/src/api.ts`:
```typescript
import type { Translation, PublishResult } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  list: () => fetch("/api/translations").then((r) => json<Translation[]>(r)),
  edit: (id: string, koreanText: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ koreanText }),
    }).then((r) => json<Translation>(r)),
  approve: (id: string) =>
    fetch(`/api/translations/${encodeURIComponent(id)}/approve`, { method: "POST" }).then((r) => json<Translation>(r)),
  publish: (target: string) =>
    fetch("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    }).then((r) => json<PublishResult>(r)),
};
```

`web/src/components/TranslationList.tsx`:
```tsx
import type { Translation } from "../types";

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="list">
      {props.items.map((t) => (
        <li
          key={t.itemId}
          className={`list-item ${t.itemId === props.selectedId ? "selected" : ""}`}
          onClick={() => props.onSelect(t.itemId)}
        >
          <span className="list-id">{t.itemId}</span>
          <span className={`badge badge-${t.status}`}>{t.status}</span>
        </li>
      ))}
    </ul>
  );
}
```

`web/src/App.tsx` (list only for now; detail/publish added in Tasks 5–6):
```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";

export function App() {
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <div className="app">
      <header className="topbar">Mantle KR — Review</header>
      {error && <div className="banner error">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <TranslationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="detail">
          {selectedId ? <p>선택됨: {selectedId}</p> : <p className="empty">항목을 선택하세요.</p>}
        </section>
      </div>
    </div>
  );
}
```

`web/src/styles.css`:
```css
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, sans-serif; color: #1a1a1a; }
.app { display: flex; flex-direction: column; height: 100vh; }
.topbar { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #0b0b0f; color: #fff; font-weight: 600; }
.main { display: flex; flex: 1; min-height: 0; }
.sidebar { width: 280px; border-right: 1px solid #e5e5e5; overflow-y: auto; }
.detail { flex: 1; padding: 16px 24px; overflow-y: auto; }
.list { list-style: none; margin: 0; padding: 0; }
.list-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #f0f0f0; cursor: pointer; }
.list-item:hover { background: #f7f7f8; }
.list-item.selected { background: #eef2ff; }
.list-id { font-size: 12px; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; }
.badge-translated { background: #fff3cd; color: #7a5b00; }
.badge-approved { background: #d1e7dd; color: #0f5132; }
.banner.error { background: #f8d7da; color: #842029; padding: 8px 16px; }
.empty { color: #888; }
.source, .korean { white-space: pre-wrap; }
textarea { width: 100%; min-height: 220px; font: inherit; padding: 8px; }
.btn { padding: 6px 14px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer; }
.btn-primary { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.btn:disabled { opacity: 0.5; cursor: default; }
hr { border: none; border-top: 1px solid #ddd; margin: 12px 0; }
```

- [ ] **Step 3: Update `.gitignore`**

Add:
```
web/dist/
web/node_modules/
```

- [ ] **Step 4: Verify the build succeeds**

Run: `pnpm build:web`
Expected: Vite builds to `web/dist/` with no errors (`web/dist/index.html` exists).

- [ ] **Step 5: Commit**

```bash
git add web/ package.json pnpm-lock.yaml .gitignore
git commit -m "feat: dashboard frontend scaffold (Vite + React) with translation list"
```

---

### Task 5: Detail view — source + editable Korean + approve

**Files:**
- Create: `web/src/components/TranslationDetail.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `api.edit`, `api.approve`, `Translation` (Task 4).
- Produces: a `TranslationDetail` component; `App` renders it for the selected item and refreshes the list on save/approve.

- [ ] **Step 1: Create `TranslationDetail.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { Translation } from "../types";

export function TranslationDetail(props: {
  item: Translation;
  onSave: (id: string, koreanText: string) => Promise<void>;
  onApprove: (id: string) => Promise<void>;
}) {
  const [korean, setKorean] = useState(props.item.koreanText);
  const [busy, setBusy] = useState(false);
  useEffect(() => setKorean(props.item.koreanText), [props.item.itemId, props.item.koreanText]);

  const dirty = korean !== props.item.koreanText;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="detail-head">
        <code>{props.item.itemId}</code>
        <span className={`badge badge-${props.item.status}`}>{props.item.status}</span>
      </div>
      <h3>원문 (source)</h3>
      <div className="source">{props.item.sourceText}</div>
      <h3>한글 (Korean){dirty ? " • 편집중" : ""}</h3>
      <textarea value={korean} onChange={(e) => setKorean(e.target.value)} />
      <div className="detail-actions">
        <button className="btn" disabled={busy || !dirty} onClick={() => run(() => props.onSave(props.item.itemId, korean))}>
          저장
        </button>
        <button className="btn btn-primary" disabled={busy || dirty} onClick={() => run(() => props.onApprove(props.item.itemId))}>
          승인 ✓
        </button>
      </div>
    </div>
  );
}
```
(Approve is disabled while there are unsaved edits — save first, then approve.)

- [ ] **Step 2: Wire it into `App.tsx`**

Replace the `<section className="detail">…</section>` block and add handlers. Full updated `App.tsx`:
```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";

export function App() {
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const onSave = async (id: string, koreanText: string) => {
    setError(null);
    try {
      await api.edit(id, koreanText);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onApprove = async (id: string) => {
    setError(null);
    try {
      await api.approve(id);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <div className="app">
      <header className="topbar">Mantle KR — Review</header>
      {error && <div className="banner error">{error}</div>}
      <div className="main">
        <aside className="sidebar">
          <TranslationList items={items} selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
        <section className="detail">
          {selected ? (
            <TranslationDetail item={selected} onSave={onSave} onApprove={onApprove} />
          ) : (
            <p className="empty">항목을 선택하세요.</p>
          )}
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `pnpm build:web`
Expected: builds with no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src
git commit -m "feat: dashboard detail view — source, editable Korean, approve"
```

---

### Task 6: Publish bar + status filter

**Files:**
- Create: `web/src/components/PublishBar.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/TranslationList.tsx`

**Interfaces:**
- Consumes: `api.publish`, `PublishResult` (Task 4).
- Produces: a `PublishBar` in the top bar; a status filter on the list.

- [ ] **Step 1: Create `PublishBar.tsx`**

```tsx
import { useState } from "react";
import { api } from "../api";

export function PublishBar() {
  const [target, setTarget] = useState("google");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const publish = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.publish(target);
      setResult(`업로드 ${r.uploaded} · 실패 ${r.failed}`);
    } catch (e) {
      setResult(`오류: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="publishbar">
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="google">google</option>
        <option value="lark">lark</option>
        <option value="both">both</option>
      </select>
      <button className="btn" disabled={busy} onClick={publish}>
        발행 ⬆
      </button>
      {result && <span className="publish-result">{result}</span>}
    </div>
  );
}
```

- [ ] **Step 2: Add a status filter to `TranslationList.tsx`**

Replace the file with a version that filters:
```tsx
import { useState } from "react";
import type { Translation } from "../types";

type Filter = "all" | "translated" | "approved";

export function TranslationList(props: {
  items: Translation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = props.items.filter((t) => filter === "all" || t.status === filter);
  return (
    <div>
      <div className="filter">
        {(["all", "translated", "approved"] as Filter[]).map((f) => (
          <button key={f} className={`chip ${filter === f ? "chip-on" : ""}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <ul className="list">
        {shown.map((t) => (
          <li
            key={t.itemId}
            className={`list-item ${t.itemId === props.selectedId ? "selected" : ""}`}
            onClick={() => props.onSelect(t.itemId)}
          >
            <span className="list-id">{t.itemId}</span>
            <span className={`badge badge-${t.status}`}>{t.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Add `PublishBar` to the top bar in `App.tsx`**

Change the header line:
```tsx
      <header className="topbar">
        <span>Mantle KR — Review</span>
        <PublishBar />
      </header>
```
and add the import at the top:
```tsx
import { PublishBar } from "./components/PublishBar";
```

- [ ] **Step 4: Add filter/publishbar styles to `web/src/styles.css`**

Append:
```css
.topbar { justify-content: space-between; }
.publishbar { display: flex; align-items: center; gap: 8px; }
.publish-result { font-size: 12px; font-weight: 400; }
.filter { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #eee; }
.chip { font-size: 12px; padding: 3px 10px; border: 1px solid #ccc; border-radius: 999px; background: #fff; cursor: pointer; }
.chip-on { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
.detail-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.detail-actions { display: flex; gap: 10px; margin-top: 12px; }
```

- [ ] **Step 5: Verify build + full backend suite**

Run: `pnpm build:web` (no errors) and `pnpm test` (all backend green) and `pnpm typecheck` (exit 0).

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat: dashboard publish bar + status filter"
```

---

## Final verification (after all tasks)

- [ ] `pnpm test` green, `pnpm typecheck` exit 0, `pnpm build:web` builds.
- [ ] `pnpm build:web && PORT=5758 pnpm serve` → open `http://localhost:5758`: list renders from `output/translations`, selecting shows source (`---` separated) + editable Korean, save/approve update the badge, publish reports a result.
- [ ] README: add a "Module E — Review dashboard" section (setup: `pnpm build:web` then `pnpm serve`; commands).
