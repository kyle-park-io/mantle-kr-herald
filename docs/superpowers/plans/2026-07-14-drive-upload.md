# Drive Upload (Subsystem D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish C's Korean translations to Google Drive AND Lark Drive as Markdown files (headless, coded REST) — `translated`→source+Korean review docs, `approved`→Korean-only finals — idempotently per drive.

**Architecture:** Hexagonal. Pure `domain/publish` (renderers, models). Ports (`DriveUploader`, `PublishStore`). Adapters: `GoogleAuth` (service-account JWT signed with `node:crypto`, LarkAuth-style caching), `GoogleDriveUploader` (Drive API v3 multipart/related), `LarkDriveUploader` (Lark `upload_all`, reuses B's `LarkAuth`), `JsonPublishStore`. Use-case `PublishTranslations` loops translations × uploaders with per-drive idempotency + per-uploader failure isolation. CLI `publish`. No new deps (native `fetch` + `node:crypto`). Reuses C's `TranslationStore`, B's `LarkAuth`, and `shared/{http,store}`.

**Tech Stack:** TypeScript (ESM), pnpm, Node 24, `zod`, native `fetch`, `node:crypto`, `vitest`, `tsx`.

## Global Constraints

- All code, identifiers, comments in English. Chat is Korean.
- ESM (`"type": "module"`), `moduleResolution: bundler` — imports need NO `.js` extension. Node built-ins as `node:...`.
- **No new runtime deps** (only `zod`). Google auth is hand-rolled service-account JWT via `node:crypto` (NOT `googleapis`).
- Secrets from env / key file only; never log them. `output/`, `.env` git-ignored.
- Upload as **Markdown files** (`text/markdown`), no Google-Doc/Lark-Doc conversion.
- `translated` → `renderReview` (source+Korean) → review folder; `approved` → `renderApproved` (Korean only) → approved folder.
- Idempotency key is **per drive**: `<itemId>:<status>:<uploaderName>` (uploaderName ∈ {google, lark}). Record only after that drive's upload succeeds. Per-uploader failures are isolated (continue; report `failed`).
- Google scope: `https://www.googleapis.com/auth/drive.file`. Google token endpoint is form-urlencoded (use native `fetch`, not the JSON HttpClient).
- Lark reuses B's `LarkAuth` (`src/adapters/lark/LarkAuth.ts`) with the same `LARK_APP_ID/SECRET/BASE_URL`; drive scope required on the app.
- Consumes C's `Translation` (`src/domain/translation/models.ts`) and `TranslationStore` (`src/adapters/store/JsonTranslationStore.ts`).
- TDD: failing test first for every unit with logic. Commit after each green task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/publish/publishModels.ts` | `FolderKind`, `UploadRequest`, `UploadResult` |
| `src/domain/publish/renderers.ts` | `renderReview`, `renderApproved`, `safeFileName` (pure) |
| `src/ports/DriveUploader.ts` | `upload(req)` + `name` |
| `src/ports/PublishStore.ts` | `listPublished` / `record` |
| `src/adapters/store/JsonPublishStore.ts` | `output/publish-state.json` |
| `src/adapters/drive/GoogleAuth.ts` | SA JWT → access token cache/refresh |
| `src/adapters/drive/GoogleDriveUploader.ts` | Drive API multipart upload |
| `src/adapters/drive/LarkDriveUploader.ts` | Lark `upload_all` (reuses `LarkAuth`) |
| `src/app/PublishTranslations.ts` | translations × uploaders, per-drive idempotent |
| `src/config.ts` | + `loadGoogleDriveConfig`, `loadLarkDriveConfig` |
| `src/cli/publish.ts` | composition root (`--target google\|lark\|both`) |
| `.env.example`, `README.md`, `docs/guides/drive-setup-guide.md` | config template + docs |
| `tests/**` | vitest unit tests + skipped live probe |

---

## Task 1: Domain — publish models + renderers (pure)

**Files:**
- Create: `src/domain/publish/publishModels.ts`, `src/domain/publish/renderers.ts`
- Test: `tests/domain/publish/renderers.test.ts`

**Interfaces:**
- Consumes: `Translation` (`src/domain/translation/models.ts`)
- Produces:
  - `FolderKind = "review" | "approved"`
  - `UploadRequest { name: string; content: string; folder: FolderKind }`
  - `UploadResult { id: string; name: string }`
  - `renderReview(t: Translation): string`
  - `renderApproved(t: Translation): string`
  - `safeFileName(itemId: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/publish/renderers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderReview, renderApproved, safeFileName } from "../../../src/domain/publish/renderers";
import type { Translation } from "../../../src/domain/translation/models";

function tr(over: Partial<Translation> = {}): Translation {
  return {
    itemId: "x:100", source: "x", sourceText: "Hello Mantle", koreanText: "안녕 맨틀",
    status: "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("safeFileName", () => {
  it("replaces non-filename chars and appends .md", () => {
    expect(safeFileName("x:100")).toBe("x-100.md");
    expect(safeFileName("lark:om_1")).toBe("lark-om_1.md");
  });
});

describe("renderReview", () => {
  it("includes the id, source text, and Korean text", () => {
    const out = renderReview(tr());
    expect(out).toContain("x:100");
    expect(out).toContain("Hello Mantle");
    expect(out).toContain("안녕 맨틀");
    expect(out).toContain("원문");
    expect(out).toContain("한글");
  });
});

describe("renderApproved", () => {
  it("contains only the Korean text (no source)", () => {
    const out = renderApproved(tr({ status: "approved", koreanText: "승인된 한글" }));
    expect(out).toContain("승인된 한글");
    expect(out).not.toContain("Hello Mantle");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/publish/renderers.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `src/domain/publish/publishModels.ts`**

```ts
export type FolderKind = "review" | "approved";

export interface UploadRequest {
  name: string;
  content: string;
  folder: FolderKind;
}

export interface UploadResult {
  id: string;
  name: string;
}
```

- [ ] **Step 4: Write `src/domain/publish/renderers.ts`**

```ts
import type { Translation } from "../translation/models";

/** Turn an itemId ("x:100") into a safe .md filename ("x-100.md"). */
export function safeFileName(itemId: string): string {
  return `${itemId.replace(/[^a-zA-Z0-9._-]/g, "-")}.md`;
}

/** Review doc: source + Korean side by side (for 1차 검수). */
export function renderReview(t: Translation): string {
  return `# ${t.itemId}\n\n## 원문 (source)\n\n${t.sourceText}\n\n## 한글 (Korean)\n\n${t.koreanText}\n`;
}

/** Approved doc: Korean text only (final). */
export function renderApproved(t: Translation): string {
  return `${t.koreanText}\n`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/domain/publish/renderers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/publish tests/domain/publish/renderers.test.ts
git commit -m "feat: publish models and pure Markdown renderers"
```

---

## Task 2: Ports

**Files:**
- Create: `src/ports/DriveUploader.ts`, `src/ports/PublishStore.ts`

**Interfaces:**
- Consumes: `UploadRequest`, `UploadResult` (Task 1)
- Produces:
  - `DriveUploader { upload(req: UploadRequest): Promise<UploadResult>; readonly name: string }`
  - `PublishStore { listPublished(): Promise<Set<string>>; record(key: string): Promise<void> }`

- [ ] **Step 1: Write `src/ports/DriveUploader.ts`**

```ts
import type { UploadRequest, UploadResult } from "../domain/publish/publishModels";

export interface DriveUploader {
  /** Upload one file to this drive's folder for req.folder. */
  upload(req: UploadRequest): Promise<UploadResult>;
  /** Stable name for idempotency keys + reporting ("google" | "lark"). */
  readonly name: string;
}
```

- [ ] **Step 2: Write `src/ports/PublishStore.ts`**

```ts
export interface PublishStore {
  /** Set of "<itemId>:<status>:<drive>" keys already uploaded. */
  listPublished(): Promise<Set<string>>;
  record(key: string): Promise<void>;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/ports/DriveUploader.ts src/ports/PublishStore.ts
git commit -m "feat: DriveUploader and PublishStore ports"
```

---

## Task 3: JsonPublishStore

**Files:**
- Create: `src/adapters/store/JsonPublishStore.ts`
- Test: `tests/adapters/store/jsonPublishStore.test.ts`

**Interfaces:**
- Consumes: `PublishStore` (Task 2), `readJsonFile`/`writeJsonFileAtomic` (`src/shared/store/jsonFile.ts`)
- Produces: `JsonPublishStore(dir: string) implements PublishStore` (persists `<dir>/publish-state.json`)

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/store/jsonPublishStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonPublishStore } from "../../../src/adapters/store/JsonPublishStore";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publish-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonPublishStore", () => {
  it("listPublished is empty initially, then reflects recorded keys", async () => {
    const store = new JsonPublishStore(dir);
    expect((await store.listPublished()).size).toBe(0);
    await store.record("x:1:translated:google");
    await store.record("x:1:translated:lark");
    const set = await store.listPublished();
    expect(set.has("x:1:translated:google")).toBe(true);
    expect(set.has("x:1:translated:lark")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("record is idempotent for the same key", async () => {
    const store = new JsonPublishStore(dir);
    await store.record("k");
    await store.record("k");
    expect((await store.listPublished()).size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/store/jsonPublishStore.test.ts`
Expected: FAIL — cannot resolve `JsonPublishStore`.

- [ ] **Step 3: Write `src/adapters/store/JsonPublishStore.ts`**

```ts
import { join } from "node:path";
import type { PublishStore } from "../../ports/PublishStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  published?: string[];
}

export class JsonPublishStore implements PublishStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "publish-state.json");
  }

  async listPublished(): Promise<Set<string>> {
    const state = await readJsonFile<StateFile>(this.path, {});
    return new Set(state.published ?? []);
  }

  async record(key: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.path, {});
    const published = new Set(state.published ?? []);
    published.add(key);
    await writeJsonFileAtomic(this.dir, this.path, { published: [...published] } satisfies StateFile);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/store/jsonPublishStore.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/store/JsonPublishStore.ts tests/adapters/store/jsonPublishStore.test.ts
git commit -m "feat: JsonPublishStore (per-drive idempotency keys)"
```

---

## Task 4: GoogleAuth (service-account JWT, node:crypto)

**Files:**
- Create: `src/adapters/drive/GoogleAuth.ts`
- Test: `tests/adapters/drive/googleAuth.test.ts`

**Interfaces:**
- Consumes: nothing (native `fetch`, `node:crypto`, `node:fs`)
- Produces:
  - `GoogleAuth(key: { client_email: string; private_key: string }, now?: () => number, fetchFn?: typeof fetch)`
  - `GoogleAuth.fromKeyFile(path: string): Promise<GoogleAuth>`
  - `getToken(force?: boolean): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/drive/googleAuth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { GoogleAuth } from "../../../src/adapters/drive/GoogleAuth";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = { client_email: "sa@project.iam.gserviceaccount.com", private_key: privateKey as string };

function fakeFetch(capture: { calls: Array<{ url: string; body: string }> }, token: string, expiresIn = 3600): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GoogleAuth", () => {
  it("mints a token via a signed JWT assertion and caches it", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    const auth = new GoogleAuth(key, () => 1_000_000, fakeFetch(cap, "ya29.token"));
    expect(await auth.getToken()).toBe("ya29.token");
    expect(await auth.getToken()).toBe("ya29.token"); // cached
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(cap.calls[0].body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(cap.calls[0].body).get("assertion") ?? "";
    expect(assertion.split(".")).toHaveLength(3); // header.claim.signature
  });

  it("refreshes when the cached token is near expiry", async () => {
    const cap = { calls: [] as Array<{ url: string; body: string }> };
    let clock = 0;
    const auth = new GoogleAuth(key, () => clock, fakeFetch(cap, "t"));
    await auth.getToken();
    clock = (3600 - 30) * 1000; // within 60s refresh margin
    await auth.getToken();
    expect(cap.calls).toHaveLength(2);
  });

  it("throws when the token response lacks access_token", async () => {
    const badFetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const auth = new GoogleAuth(key, () => 0, badFetch);
    await expect(auth.getToken()).rejects.toThrow(/access_token/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/drive/googleAuth.test.ts`
Expected: FAIL — cannot resolve `GoogleAuth`.

- [ ] **Step 3: Write `src/adapters/drive/GoogleAuth.ts`**

```ts
import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const REFRESH_MARGIN_SECONDS = 60;

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class GoogleAuth {
  private token?: string;
  private expiresAt = 0; // ms epoch

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly now: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static async fromKeyFile(path: string): Promise<GoogleAuth> {
    const raw = JSON.parse(await readFile(path, "utf8")) as ServiceAccountKey;
    if (!raw.client_email || !raw.private_key) {
      throw new Error(`Invalid Google service account key file: ${path}`);
    }
    return new GoogleAuth(raw);
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return this.token;

    const iat = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    );
    const signingInput = `${header}.${claim}`;
    const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(this.key.private_key));
    const assertion = `${signingInput}.${signature}`;

    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google token response missing access_token");

    this.token = body.access_token;
    this.expiresAt = this.now() + Math.max((body.expires_in ?? 3600) - REFRESH_MARGIN_SECONDS, 0) * 1000;
    return this.token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/drive/googleAuth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/drive/GoogleAuth.ts tests/adapters/drive/googleAuth.test.ts
git commit -m "feat: GoogleAuth service-account JWT via node:crypto (no new deps)"
```

---

## Task 5: GoogleDriveUploader

**Files:**
- Create: `src/adapters/drive/GoogleDriveUploader.ts`
- Test: `tests/adapters/drive/googleDriveUploader.test.ts`

**Interfaces:**
- Consumes: `GoogleAuth` (Task 4), `DriveUploader` (Task 2), `UploadRequest`/`UploadResult`/`FolderKind` (Task 1)
- Produces: `GoogleDriveUploader(auth: { getToken(): Promise<string> }, folders: Record<FolderKind, string>, fetchFn?: typeof fetch) implements DriveUploader` (`name = "google"`)

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/drive/googleDriveUploader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GoogleDriveUploader } from "../../../src/adapters/drive/GoogleDriveUploader";

const auth = { getToken: async () => "ya29.tok" };
const folders = { review: "REVIEW_FOLDER", approved: "APPROVED_FOLDER" };

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; body?: string }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.body = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "file123", name: "x-1.md" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GoogleDriveUploader", () => {
  it("uploads multipart/related with bearer token and the review folder as parent", async () => {
    const cap: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(uploader.name).toBe("google");
    expect(cap.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    expect(cap.headers?.["Authorization"]).toBe("Bearer ya29.tok");
    expect(cap.headers?.["Content-Type"]).toContain("multipart/related; boundary=");
    expect(cap.body).toContain('"name":"x-1.md"');
    expect(cap.body).toContain('"parents":["REVIEW_FOLDER"]');
    expect(cap.body).toContain("# hi");
    expect(result).toEqual({ id: "file123", name: "x-1.md" });
  });

  it("maps the approved folder", async () => {
    const cap: { body?: string } = {};
    const uploader = new GoogleDriveUploader(auth, folders, fakeFetch(cap));
    await uploader.upload({ name: "x-2.md", content: "c", folder: "approved" });
    expect(cap.body).toContain('"parents":["APPROVED_FOLDER"]');
  });

  it("throws on a non-ok response", async () => {
    const badFetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    const uploader = new GoogleDriveUploader(auth, folders, badFetch);
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/drive/googleDriveUploader.test.ts`
Expected: FAIL — cannot resolve `GoogleDriveUploader`.

- [ ] **Step 3: Write `src/adapters/drive/GoogleDriveUploader.ts`**

```ts
import type { FolderKind, UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";

interface TokenSource {
  getToken(): Promise<string>;
}

export class GoogleDriveUploader implements DriveUploader {
  readonly name = "google";

  constructor(
    private readonly auth: TokenSource,
    private readonly folders: Record<FolderKind, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: req.name, parents: [this.folders[req.folder]] });
    const body =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      "Content-Type: text/markdown; charset=UTF-8\r\n\r\n" +
      `${req.content}\r\n` +
      `--${boundary}--`;

    const res = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`Google Drive upload failed: HTTP ${res.status}`);
    const data = (await res.json()) as { id?: string; name?: string };
    if (!data.id) throw new Error("Google Drive upload response missing id");
    return { id: data.id, name: data.name ?? req.name };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/drive/googleDriveUploader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/drive/GoogleDriveUploader.ts tests/adapters/drive/googleDriveUploader.test.ts
git commit -m "feat: GoogleDriveUploader (Drive API v3 multipart/related)"
```

---

## Task 6: LarkDriveUploader

**Files:**
- Create: `src/adapters/drive/LarkDriveUploader.ts`
- Test: `tests/adapters/drive/larkDriveUploader.test.ts`

**Interfaces:**
- Consumes: `DriveUploader` (Task 2), `UploadRequest`/`FolderKind` (Task 1), a `{ getToken(): Promise<string> }` (B's `LarkAuth` satisfies it)
- Produces: `LarkDriveUploader(auth, baseUrl: string, folders: Record<FolderKind, string>, fetchFn?: typeof fetch) implements DriveUploader` (`name = "lark"`)

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/drive/larkDriveUploader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LarkDriveUploader } from "../../../src/adapters/drive/LarkDriveUploader";

const auth = { getToken: async () => "t-lark" };
const folders = { review: "REVIEW_TOKEN", approved: "APPROVED_TOKEN" };

function fakeFetch(capture: { url?: string; headers?: Record<string, string>; form?: FormData }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    capture.url = String(url);
    capture.headers = init?.headers as Record<string, string>;
    capture.form = init?.body as FormData;
    return new Response(JSON.stringify({ code: 0, data: { file_token: "flk_1" } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("LarkDriveUploader", () => {
  it("uploads multipart/form-data to upload_all with the review folder token", async () => {
    const cap: { url?: string; headers?: Record<string, string>; form?: FormData } = {};
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, fakeFetch(cap));

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(uploader.name).toBe("lark");
    expect(cap.url).toBe("https://open.larksuite.com/open-apis/drive/v1/files/upload_all");
    expect(cap.headers?.["Authorization"]).toBe("Bearer t-lark");
    expect(cap.form?.get("file_name")).toBe("x-1.md");
    expect(cap.form?.get("parent_type")).toBe("explorer");
    expect(cap.form?.get("parent_node")).toBe("REVIEW_TOKEN");
    expect(cap.form?.get("size")).toBe(String(Buffer.byteLength("# hi", "utf8")));
    expect(result).toEqual({ id: "flk_1", name: "x-1.md" });
  });

  it("throws when the Lark envelope code is non-zero", async () => {
    const badFetch = (async () =>
      new Response(JSON.stringify({ code: 1061045, msg: "no permission" }), { status: 200 })) as unknown as typeof fetch;
    const uploader = new LarkDriveUploader(auth, "https://open.larksuite.com", folders, badFetch);
    await expect(uploader.upload({ name: "n", content: "c", folder: "review" })).rejects.toThrow(/1061045|no permission/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/drive/larkDriveUploader.test.ts`
Expected: FAIL — cannot resolve `LarkDriveUploader`.

- [ ] **Step 3: Write `src/adapters/drive/LarkDriveUploader.ts`**

```ts
import type { FolderKind, UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

interface TokenSource {
  getToken(): Promise<string>;
}

export class LarkDriveUploader implements DriveUploader {
  readonly name = "lark";

  constructor(
    private readonly auth: TokenSource,
    private readonly baseUrl: string,
    private readonly folders: Record<FolderKind, string>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    const token = await this.auth.getToken();
    const bytes = Buffer.from(req.content, "utf8");
    const form = new FormData();
    form.append("file_name", req.name);
    form.append("parent_type", "explorer");
    form.append("parent_node", this.folders[req.folder]);
    form.append("size", String(bytes.length));
    form.append("file", new Blob([bytes], { type: "text/markdown" }), req.name);

    const res = await this.fetchFn(`${this.baseUrl}/open-apis/drive/v1/files/upload_all`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = (await res.json()) as { code?: number; msg?: string; data?: { file_token?: string } };
    if (data.code !== 0 || !data.data?.file_token) {
      throw new Error(`Lark Drive upload failed: code=${data.code} ${data.msg ?? ""}`.trim());
    }
    return { id: data.data.file_token, name: req.name };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/drive/larkDriveUploader.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/drive/LarkDriveUploader.ts tests/adapters/drive/larkDriveUploader.test.ts
git commit -m "feat: LarkDriveUploader (Drive upload_all, reuses LarkAuth)"
```

---

## Task 7: PublishTranslations use-case

**Files:**
- Create: `src/app/PublishTranslations.ts`
- Test: `tests/app/publishTranslations.test.ts`

**Interfaces:**
- Consumes: `TranslationStore` (`src/ports/TranslationStore.ts`, from C), `DriveUploader`/`PublishStore` (Task 2), renderers (Task 1)
- Produces: `PublishTranslations(translationStore, uploaders: DriveUploader[], publishStore)`; `run(): Promise<{ uploaded: number; failed: number; byDrive: Record<string, number> }>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/publishTranslations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PublishTranslations } from "../../src/app/PublishTranslations";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { DriveUploader } from "../../src/ports/DriveUploader";
import type { PublishStore } from "../../src/ports/PublishStore";
import type { Translation } from "../../src/domain/translation/models";
import type { UploadRequest, UploadResult } from "../../src/domain/publish/publishModels";

function tr(itemId: string, status: Translation["status"]): Translation {
  return { itemId, source: "x", sourceText: `src-${itemId}`, koreanText: `ko-${itemId}`, status, translatedAt: "t" };
}

function translationStore(list: Translation[]): TranslationStore {
  return { loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set() };
}

class FakeUploader implements DriveUploader {
  public reqs: UploadRequest[] = [];
  constructor(public readonly name: string, private readonly fail = false) {}
  async upload(req: UploadRequest): Promise<UploadResult> {
    if (this.fail) throw new Error("boom");
    this.reqs.push(req);
    return { id: `${this.name}-${req.name}`, name: req.name };
  }
}

class InMemoryPublishStore implements PublishStore {
  public keys = new Set<string>();
  async listPublished() { return this.keys; }
  async record(key: string) { this.keys.add(key); }
}

describe("PublishTranslations", () => {
  it("uploads review docs for translated + approved docs for approved, to every uploader, and records per drive", async () => {
    const g = new FakeUploader("google");
    const l = new FakeUploader("lark");
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated"), tr("x:2", "approved")]), [g, l], store);

    const res = await uc.run();

    expect(res.uploaded).toBe(4); // 2 items × 2 drives
    expect(res.byDrive).toEqual({ google: 2, lark: 2 });
    // review folder for translated, approved for approved
    expect(g.reqs.find((r) => r.name === "x-1.md")?.folder).toBe("review");
    expect(g.reqs.find((r) => r.name === "x-2.md")?.folder).toBe("approved");
    // review doc contains source, approved doc does not
    expect(g.reqs.find((r) => r.name === "x-1.md")?.content).toContain("src-x:1");
    expect(g.reqs.find((r) => r.name === "x-2.md")?.content).not.toContain("src-x:2");
    expect(store.keys.has("x:1:translated:google")).toBe(true);
    expect(store.keys.has("x:2:approved:lark")).toBe(true);
  });

  it("skips keys already published (per drive)", async () => {
    const g = new FakeUploader("google");
    const store = new InMemoryPublishStore();
    store.keys.add("x:1:translated:google");
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated")]), [g], store);
    const res = await uc.run();
    expect(res.uploaded).toBe(0);
    expect(g.reqs).toHaveLength(0);
  });

  it("isolates a failing uploader: records the good drive, counts the failure, keeps going", async () => {
    const good = new FakeUploader("google");
    const bad = new FakeUploader("lark", true);
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated")]), [good, bad], store);
    const res = await uc.run();
    expect(res.uploaded).toBe(1);
    expect(res.failed).toBe(1);
    expect(store.keys.has("x:1:translated:google")).toBe(true);
    expect(store.keys.has("x:1:translated:lark")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/publishTranslations.test.ts`
Expected: FAIL — cannot resolve `PublishTranslations`.

- [ ] **Step 3: Write `src/app/PublishTranslations.ts`**

```ts
import { renderApproved, renderReview, safeFileName } from "../domain/publish/renderers";
import type { FolderKind } from "../domain/publish/publishModels";
import type { TranslationStore } from "../ports/TranslationStore";
import type { DriveUploader } from "../ports/DriveUploader";
import type { PublishStore } from "../ports/PublishStore";

export interface PublishResult {
  uploaded: number;
  failed: number;
  byDrive: Record<string, number>;
}

export class PublishTranslations {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly uploaders: DriveUploader[],
    private readonly publishStore: PublishStore,
  ) {}

  async run(): Promise<PublishResult> {
    const published = await this.publishStore.listPublished();
    let uploaded = 0;
    let failed = 0;
    const byDrive: Record<string, number> = {};

    for (const t of await this.translationStore.loadAll()) {
      const content = t.status === "approved" ? renderApproved(t) : renderReview(t);
      const folder: FolderKind = t.status === "approved" ? "approved" : "review";
      const name = safeFileName(t.itemId);

      for (const uploader of this.uploaders) {
        const key = `${t.itemId}:${t.status}:${uploader.name}`;
        if (published.has(key)) continue;
        try {
          await uploader.upload({ name, content, folder });
          await this.publishStore.record(key);
          uploaded += 1;
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch {
          failed += 1;
        }
      }
    }

    return { uploaded, failed, byDrive };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/publishTranslations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/PublishTranslations.ts tests/app/publishTranslations.test.ts
git commit -m "feat: PublishTranslations use-case (per-drive idempotent, failure-isolated)"
```

---

## Task 8: Config + CLI + probe + docs

**Files:**
- Modify: `src/config.ts`, `.env.example`, `README.md`, `package.json`
- Create: `src/cli/publish.ts`, `tests/adapters/drive/drive.probe.test.ts`, `docs/guides/drive-setup-guide.md`
- Test: `tests/config.test.ts` (add drive config cases)

**Interfaces:**
- Consumes: everything above + B's `LarkAuth`, shared `HttpClient`, C's `JsonTranslationStore`
- Produces: `loadGoogleDriveConfig()`, `loadLarkDriveConfig()`; runnable `pnpm publish`

- [ ] **Step 1: Write the failing config test**

Add to `tests/config.test.ts` (keep existing tests; add a describe). Ensure the vitest import has `beforeEach`/`afterEach`:

```ts
import { loadGoogleDriveConfig, loadLarkDriveConfig } from "../src/config";

describe("loadGoogleDriveConfig", () => {
  const keys = ["GOOGLE_SA_KEY_FILE", "GDRIVE_REVIEW_FOLDER_ID", "GDRIVE_APPROVED_FOLDER_ID"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("reads the three Google env vars", () => {
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    process.env.GDRIVE_REVIEW_FOLDER_ID = "R";
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(loadGoogleDriveConfig()).toEqual({ saKeyFile: "/k.json", reviewFolderId: "R", approvedFolderId: "A" });
  });

  it("throws when the key file var is missing", () => {
    delete process.env.GOOGLE_SA_KEY_FILE;
    process.env.GDRIVE_REVIEW_FOLDER_ID = "R";
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(() => loadGoogleDriveConfig()).toThrow(/GOOGLE_SA_KEY_FILE/);
  });
});

describe("loadLarkDriveConfig", () => {
  const keys = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_BASE_URL", "LARK_DRIVE_REVIEW_FOLDER_TOKEN", "LARK_DRIVE_APPROVED_FOLDER_TOKEN"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("reads app creds + folder tokens and defaults baseUrl", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    delete process.env.LARK_BASE_URL;
    process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN = "R";
    process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN = "A";
    expect(loadLarkDriveConfig()).toEqual({
      appId: "cli_x", appSecret: "sec", baseUrl: "https://open.larksuite.com",
      reviewFolderToken: "R", approvedFolderToken: "A",
    });
  });

  it("throws when a folder token is missing", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN = "R";
    delete process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN;
    expect(() => loadLarkDriveConfig()).toThrow(/LARK_DRIVE_APPROVED_FOLDER_TOKEN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/config.test.ts`
Expected: FAIL — the two loaders are not exported.

- [ ] **Step 3: Append to `src/config.ts`**

```ts
export interface GoogleDriveConfig {
  saKeyFile: string;
  reviewFolderId: string;
  approvedFolderId: string;
}

export function loadGoogleDriveConfig(): GoogleDriveConfig {
  const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;
  const reviewFolderId = process.env.GDRIVE_REVIEW_FOLDER_ID;
  const approvedFolderId = process.env.GDRIVE_APPROVED_FOLDER_ID;
  if (!saKeyFile) throw new Error("Missing required environment variable: GOOGLE_SA_KEY_FILE");
  if (!reviewFolderId) throw new Error("Missing required environment variable: GDRIVE_REVIEW_FOLDER_ID");
  if (!approvedFolderId) throw new Error("Missing required environment variable: GDRIVE_APPROVED_FOLDER_ID");
  return { saKeyFile, reviewFolderId, approvedFolderId };
}

export interface LarkDriveConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  reviewFolderToken: string;
  approvedFolderToken: string;
}

export function loadLarkDriveConfig(): LarkDriveConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId) throw new Error("Missing required environment variable: LARK_APP_ID");
  if (!appSecret) throw new Error("Missing required environment variable: LARK_APP_SECRET");
  const reviewFolderToken = process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN;
  const approvedFolderToken = process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN;
  if (!reviewFolderToken) throw new Error("Missing required environment variable: LARK_DRIVE_REVIEW_FOLDER_TOKEN");
  if (!approvedFolderToken) throw new Error("Missing required environment variable: LARK_DRIVE_APPROVED_FOLDER_TOKEN");
  const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
  return { appId, appSecret, baseUrl, reviewFolderToken, approvedFolderToken };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/config.test.ts`
Expected: PASS (existing + 4 new).

- [ ] **Step 5: Write `src/cli/publish.ts`**

```ts
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { GoogleAuth } from "../adapters/drive/GoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = argValue("--target") ?? "both"; // google | lark | both
const uploaders: DriveUploader[] = [];

if (target === "google" || target === "both") {
  const g = loadGoogleDriveConfig();
  const auth = await GoogleAuth.fromKeyFile(g.saKeyFile);
  uploaders.push(new GoogleDriveUploader(auth, { review: g.reviewFolderId, approved: g.approvedFolderId }));
}
if (target === "lark" || target === "both") {
  const l = loadLarkDriveConfig();
  const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
  uploaders.push(new LarkDriveUploader(auth, l.baseUrl, { review: l.reviewFolderToken, approved: l.approvedFolderToken }));
}
if (uploaders.length === 0) {
  throw new Error('No target selected. Use --target google|lark|both');
}

const usecase = new PublishTranslations(new JsonTranslationStore("output"), uploaders, new JsonPublishStore("output"));
const result = await usecase.run();
console.log(`published ${result.uploaded} file(s) across ${uploaders.length} drive(s); ${result.failed} failure(s)`);
console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
```

- [ ] **Step 6: Add `publish` script to `package.json`**

In `"scripts"` add:
```json
    "publish": "tsx --env-file-if-exists=.env src/cli/publish.ts",
```

- [ ] **Step 7: Write the live probe**

Create `tests/adapters/drive/drive.probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { GoogleAuth } from "../../../src/adapters/drive/GoogleAuth";

const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;

// Skipped unless a Google service-account key file is configured.
describe.skipIf(!saKeyFile)("PROBE: Google service-account auth", () => {
  it("mints a real access token from the service account key", async () => {
    await readFile(saKeyFile!, "utf8"); // fail fast if unreadable
    const auth = await GoogleAuth.fromKeyFile(saKeyFile!);
    const token = await auth.getToken();
    // eslint-disable-next-line no-console
    console.log(`[probe] Google token acquired (len ${token.length})`);
    expect(token.length).toBeGreaterThan(0);
  }, 30000);
});
```

- [ ] **Step 8: Verify probe skips + full suite + typecheck**

Run: `pnpm test tests/adapters/drive/drive.probe.test.ts` → probe **skipped** (no key), exit 0.
Run: `pnpm test && pnpm typecheck` → all pass; typecheck exit 0.

- [ ] **Step 9: Update `.env.example`**

Append:
```bash
# Required for Google Drive upload (subsystem D). Create a GCP service account,
# download its JSON key, enable Drive API, and share the target folders with the
# service account email. Folder IDs are in the Drive folder URL.
GOOGLE_SA_KEY_FILE=
GDRIVE_REVIEW_FOLDER_ID=
GDRIVE_APPROVED_FOLDER_ID=

# Required for Lark Drive upload (subsystem D). Reuses the Lark app above
# (LARK_APP_ID/SECRET) — add a drive scope to it. Folder tokens are in the
# Lark drive folder URL.
LARK_DRIVE_REVIEW_FOLDER_TOKEN=
LARK_DRIVE_APPROVED_FOLDER_TOKEN=
```

- [ ] **Step 10: Create `docs/guides/drive-setup-guide.md`**

```markdown
# 드라이브 셋업 가이드 — Google Drive + Lark Drive (서브시스템 D)

> `pnpm publish`가 번역 결과를 두 드라이브에 올리려면 아래 값을 `.env`에 채워야 합니다.

## Google Drive

1. **GCP 프로젝트** (console.cloud.google.com) → 없으면 생성.
2. **Google Drive API 사용 설정**: APIs & Services → Enable APIs → "Google Drive API" 검색 → 사용.
3. **서비스 계정 생성**: IAM & Admin → Service Accounts → Create → 이름 지정 → 완료. 생성된 서비스
   계정 **이메일**(…@….iam.gserviceaccount.com)을 복사.
4. **JSON 키 발급**: 그 서비스 계정 → Keys → Add Key → JSON → 다운로드. 파일 경로를 `.env`의
   `GOOGLE_SA_KEY_FILE`에.
5. **폴더 공유**: Google Drive에서 review용 / approved용 폴더를 각각 만들고, 각 폴더를 **서비스 계정
   이메일과 편집자(Editor)로 공유**. (서비스 계정은 자기 소유 파일만 접근하므로 공유가 필수)
6. **폴더 ID**: 폴더 URL `https://drive.google.com/drive/folders/<FOLDER_ID>`의 `<FOLDER_ID>`를
   `.env`의 `GDRIVE_REVIEW_FOLDER_ID` / `GDRIVE_APPROVED_FOLDER_ID`에.

## Lark Drive

1. **B에서 만든 Lark 앱**을 그대로 사용 (`LARK_APP_ID`/`LARK_APP_SECRET`).
2. **Drive 스코프 추가**: 앱 → Permissions & Scopes → `drive:drive`(또는 파일 업로드 권한) 추가 →
   버전 릴리스(승인).
3. **대상 폴더**: Lark Drive에서 review / approved 폴더 생성 → 앱(봇)이 접근 가능하도록 공유.
4. **폴더 token**: 폴더 URL의 토큰을 `.env`의 `LARK_DRIVE_REVIEW_FOLDER_TOKEN` /
   `LARK_DRIVE_APPROVED_FOLDER_TOKEN`에.

## 실행

```bash
pnpm publish                 # 둘 다
pnpm publish --target google # 구글만
pnpm publish --target lark   # Lark만
```
`output/publish-state.json`이 (아이템:상태:드라이브)별로 업로드 이력을 기록해 중복 업로드를 막습니다.
```

- [ ] **Step 11: Update `README.md`**

Add a section after Module C:
```markdown
## Module D — Drive upload (Google + Lark)

Publishes C's translations to Google Drive and Lark Drive as Markdown: `translated` → source+Korean review docs, `approved` → Korean-only finals. Headless (coded REST), no Claude API.

### Setup

See `docs/guides/drive-setup-guide.md`. Fill `.env`: `GOOGLE_SA_KEY_FILE`, `GDRIVE_REVIEW_FOLDER_ID`, `GDRIVE_APPROVED_FOLDER_ID`, `LARK_DRIVE_REVIEW_FOLDER_TOKEN`, `LARK_DRIVE_APPROVED_FOLDER_TOKEN` (Lark app creds reused from Module B).

### Commands

```bash
pnpm publish [--target google|lark|both]
```

Idempotent per drive via `output/publish-state.json`.
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: drive-upload config, publish CLI, probe, .env.example, README, setup guide"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** renderers + models (§4) → Task 1; ports (§5) → Task 2; publish store per-drive idempotency (§5/§8) → Task 3; GoogleAuth JWT (§6-1) → Task 4; GoogleDriveUploader (§6-2) → Task 5; LarkDriveUploader reusing LarkAuth (§6-3) → Task 6; PublishTranslations flow + failure isolation (§7/§8) → Task 7; config/CLI/probe/provisioning docs (§10/§11/§12) → Task 8. `MultiUploader` intentionally not built (use-case loops uploaders). No secrets logged. No new deps.
- **Placeholder scan:** every code/test step has complete code + exact commands. No TBD/TODO.
- **Type consistency:** `FolderKind`, `UploadRequest`, `UploadResult`, `DriveUploader` (`upload` + `name`), `PublishStore`, `PublishResult` defined once (Tasks 1/2/7) and consumed with matching signatures. `getToken()` shape shared by GoogleAuth/LarkAuth via the `TokenSource` structural type. Reused `Translation`/`TranslationStore` (C) and `LarkAuth` (B) match their real definitions.

## Notes / Deferred (out of scope for subsystem D)

- Post-upload Lark notification → bot (subsystem H).
- Recording upload history/links into Google Sheet → subsystem G.
- Google resumable upload (for large files) — `upload_all`/multipart cover Markdown-sized files.
- Google-Doc / Lark-Doc native conversion — Markdown files only for now.
