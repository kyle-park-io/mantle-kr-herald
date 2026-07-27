# config:push / config:pull Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up and share the git-ignored steering config to Google Drive — `config:push` bundles `translation/`+`conversion/` (minus `*.example.*`) into one timestamped JSON snapshot; `config:pull` restores the latest, backing up the local tree first.

**Architecture:** A pure bundle assembler/parser; a `GoogleConfigDrive` adapter (raw upload + list + download, injected `fetch`); a `ConfigFileStore` port + `FsConfigFileStore` (list/write/backup); `PushConfig`/`PullConfig` use-cases; two CLIs with auto-provisioned config folder. Single-maintainer, Drive = transport, repo = edit surface.

**Tech Stack:** ESM TypeScript, `zod` (bundle + response parsing), `vitest`, `tsx`, `node:fs/promises`, native `fetch`.

## Global Constraints

- Runtime deps stay **zod-only**; no new dependency. Drive I/O uses `fetch`; parsing uses `zod`.
- `config:pull` never leaves a half-written local tree: **back up the current config first**, and abort the whole pull on a backup or bundle-parse failure before touching any file.
- Synced set = every file in `translation/` + `conversion/` whose name does **not** contain `.example.` (tracked skeletons are never bundled). Directory scan — no git dependency.
- Not storage-mode-gated (needs only Google OAuth + the config folder), unlike `skipIfLocal` commands.
- Public repo: tests use synthetic files; no steering content, tokens, or Drive folder ids committed.
- Every test can fail: pin concrete paths/content/queries.

---

## File Structure

- **Create** `src/domain/config/bundle.ts` — `ConfigFile`, `assembleConfigBundle`, `parseConfigBundle`.
- **Create** `src/ports/ConfigDrive.ts`, `src/ports/ConfigFileStore.ts`.
- **Create** `src/adapters/drive/GoogleConfigDrive.ts`, `src/adapters/store/FsConfigFileStore.ts`.
- **Create** `src/app/PushConfig.ts`, `src/app/PullConfig.ts`.
- **Create** `src/cli/config-push.ts`, `src/cli/config-pull.ts`.
- **Modify** `src/config.ts` (`loadGoogleConfigFolder`), `package.json`, `.env.example`, `CHANGELOG.md`, `docs/ko/capabilities.md`.
- **Tests:** `tests/domain/config/bundle.test.ts`, `tests/adapters/googleConfigDrive.test.ts`, `tests/adapters/fsConfigFileStore.test.ts`, `tests/app/{pushConfig,pullConfig}.test.ts`.

---

## Task 1: `ConfigBundle` — pure assemble/parse

**Files:** Create `src/domain/config/bundle.ts`; Test `tests/domain/config/bundle.test.ts`

**Interfaces:**
- Produces: `interface ConfigFile { path: string; content: string }`, `assembleConfigBundle(files: ConfigFile[], now?): string`, `parseConfigBundle(json: string): ConfigFile[]`.

- [ ] **Step 1: Write the failing test** (`tests/domain/config/bundle.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { assembleConfigBundle, parseConfigBundle } from "../../../src/domain/config/bundle";

describe("config bundle", () => {
  it("round-trips files through assemble → parse", () => {
    const files = [
      { path: "translation/glossary.json", content: "[]" },
      { path: "conversion/announcement.md", content: "# 공지" },
    ];
    const json = assembleConfigBundle(files, () => "2026-07-28T00:00:00.000Z");
    expect(parseConfigBundle(json)).toEqual(files);
  });

  it("writes version + pushedAt", () => {
    const json = assembleConfigBundle([], () => "2026-07-28T00:00:00.000Z");
    const obj = JSON.parse(json);
    expect(obj.version).toBe(1);
    expect(obj.pushedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(obj.files).toEqual({});
  });

  it("rejects a non-JSON download", () => {
    expect(() => parseConfigBundle("not json")).toThrow(/not a valid config bundle/);
  });

  it("rejects a bundle missing the files map", () => {
    expect(() => parseConfigBundle(JSON.stringify({ version: 1, pushedAt: "t" }))).toThrow(/not a valid config bundle/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run tests/domain/config/bundle.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/domain/config/bundle.ts`

```ts
import { z } from "zod";

export interface ConfigFile {
  path: string;
  content: string;
}

const BundleSchema = z.object({
  version: z.literal(1),
  pushedAt: z.string(),
  files: z.record(z.string(), z.string()),
});

export function assembleConfigBundle(files: ConfigFile[], now: () => string = () => new Date().toISOString()): string {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  return JSON.stringify({ version: 1, pushedAt: now(), files: map }, null, 2);
}

export function parseConfigBundle(json: string): ConfigFile[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("downloaded snapshot is not a valid config bundle (not JSON)");
  }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`downloaded snapshot is not a valid config bundle: ${parsed.error.message}`);
  return Object.entries(parsed.data.files).map(([path, content]) => ({ path, content }));
}
```

- [ ] **Step 4: Run to verify pass.** **Step 5: Commit** `git commit -m "feat(config): ConfigBundle assemble/parse"`.

---

## Task 2: `GoogleConfigDrive` adapter

**Files:** Create `src/ports/ConfigDrive.ts`, `src/adapters/drive/GoogleConfigDrive.ts`; Test `tests/adapters/googleConfigDrive.test.ts`

**Interfaces:**
- Produces: `interface ConfigDrive { upload(folderId, name, content): Promise<{id:string}>; latest(folderId, prefix): Promise<{id:string;name:string}|undefined>; download(fileId): Promise<string> }` (port), and `GoogleConfigDrive implements ConfigDrive`.
- Consumes: `TokenSource` from `./TokenSource`.

- [ ] **Step 1: Create the port** `src/ports/ConfigDrive.ts`

```ts
export interface ConfigDrive {
  upload(folderId: string, name: string, content: string): Promise<{ id: string }>;
  latest(folderId: string, prefix: string): Promise<{ id: string; name: string } | undefined>;
  download(fileId: string): Promise<string>;
}
```

- [ ] **Step 2: Write the failing test** (`tests/adapters/googleConfigDrive.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { GoogleConfigDrive } from "../../src/adapters/drive/GoogleConfigDrive";
import type { TokenSource } from "../../src/adapters/drive/TokenSource";

const auth: TokenSource = { getToken: async () => "tok" };

function fakeFetch(handler: (url: string, init?: RequestInit) => { ok: boolean; status?: number; json?: unknown; text?: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 500), json: async () => r.json, text: async () => r.text ?? "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("GoogleConfigDrive", () => {
  it("upload posts a multipart body carrying the name, parent, and content", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { id: "F1" } }));
    const res = await new GoogleConfigDrive(auth, f.fn).upload("FOLDER", "steering-config-x.json", "{\"a\":1}");
    expect(res).toEqual({ id: "F1" });
    const body = String(f.calls[0].init!.body);
    expect(body).toContain("steering-config-x.json");
    expect(body).toContain("FOLDER");
    expect(body).toContain("{\"a\":1}");
    expect(f.calls[0].url).toContain("uploadType=multipart");
  });

  it("latest queries by folder+prefix ordered by createdTime desc and returns the first", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { files: [{ id: "L1", name: "steering-config-2.json" }, { id: "L2", name: "steering-config-1.json" }] } }));
    const res = await new GoogleConfigDrive(auth, f.fn).latest("FOLDER", "steering-config-");
    expect(res).toEqual({ id: "L1", name: "steering-config-2.json" });
    expect(decodeURIComponent(f.calls[0].url)).toContain("'FOLDER' in parents");
    expect(decodeURIComponent(f.calls[0].url)).toContain("createdTime desc");
  });

  it("latest returns undefined on an empty folder", async () => {
    const f = fakeFetch(() => ({ ok: true, json: { files: [] } }));
    expect(await new GoogleConfigDrive(auth, f.fn).latest("FOLDER", "steering-config-")).toBeUndefined();
  });

  it("download GETs ?alt=media and returns the body text", async () => {
    const f = fakeFetch(() => ({ ok: true, text: "BUNDLE" }));
    expect(await new GoogleConfigDrive(auth, f.fn).download("F1")).toBe("BUNDLE");
    expect(f.calls[0].url).toContain("/F1?alt=media");
  });

  it("surfaces a non-ok upload", async () => {
    const f = fakeFetch(() => ({ ok: false, status: 403, text: "denied" }));
    await expect(new GoogleConfigDrive(auth, f.fn).upload("F", "n", "c")).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement** `src/adapters/drive/GoogleConfigDrive.ts`

```ts
import { z } from "zod";
import type { TokenSource } from "./TokenSource";
import type { ConfigDrive } from "../../ports/ConfigDrive";

const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

function multipartBody(metadata: object, content: string): { boundary: string; body: string } {
  const boundary = `cfg${Date.now()}`;
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  return { boundary, body };
}

const ListSchema = z.object({ files: z.array(z.object({ id: z.string(), name: z.string() })).nullish() });

export class GoogleConfigDrive implements ConfigDrive {
  constructor(private readonly auth: TokenSource, private readonly fetchFn: typeof fetch = fetch) {}

  async upload(folderId: string, name: string, content: string): Promise<{ id: string }> {
    const token = await this.auth.getToken();
    const { boundary, body } = multipartBody({ name, parents: [folderId] }, content);
    const res = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`config upload failed: HTTP ${res.status} — ${await res.text()}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("config upload response missing id");
    return { id: data.id };
  }

  async latest(folderId: string, prefix: string): Promise<{ id: string; name: string } | undefined> {
    const token = await this.auth.getToken();
    const q = `'${folderId}' in parents and name contains '${prefix}' and trashed = false`;
    const url = `${FILES_URL}?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent("createdTime desc")}&pageSize=1&fields=${encodeURIComponent("files(id,name)")}`;
    const res = await this.fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`config list failed: HTTP ${res.status}`);
    const data = ListSchema.parse(await res.json());
    return (data.files ?? [])[0];
  }

  async download(fileId: string): Promise<string> {
    const token = await this.auth.getToken();
    const res = await this.fetchFn(`${FILES_URL}/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`config download failed: HTTP ${res.status}`);
    return await res.text();
  }
}
```

- [ ] **Step 5: Run to verify pass. Commit** `git commit -m "feat(config): GoogleConfigDrive — upload/latest/download"`.

---

## Task 3: `ConfigFileStore` port + `FsConfigFileStore`

**Files:** Create `src/ports/ConfigFileStore.ts`, `src/adapters/store/FsConfigFileStore.ts`; Test `tests/adapters/fsConfigFileStore.test.ts`

**Interfaces:**
- Produces: `interface ConfigFileStore { list(): Promise<ConfigFile[]>; write(path, content): Promise<void>; backup(destDir): Promise<void> }` and `FsConfigFileStore`.
- Consumes: `ConfigFile` from `../../domain/config/bundle`.

- [ ] **Step 1: Create the port** `src/ports/ConfigFileStore.ts`

```ts
import type { ConfigFile } from "../domain/config/bundle";

export interface ConfigFileStore {
  list(): Promise<ConfigFile[]>;
  write(path: string, content: string): Promise<void>;
  backup(destDir: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test** (`tests/adapters/fsConfigFileStore.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsConfigFileStore } from "../../src/adapters/store/FsConfigFileStore";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cfg-"));
  await mkdir(join(root, "translation"), { recursive: true });
  await mkdir(join(root, "conversion"), { recursive: true });
  await writeFile(join(root, "translation", "glossary.json"), "[]", "utf8");
  await writeFile(join(root, "translation", "glossary.example.json"), "[]", "utf8"); // skipped
  await writeFile(join(root, "conversion", "announcement.md"), "# 공지", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function store(): FsConfigFileStore {
  return new FsConfigFileStore(
    [{ abs: join(root, "translation"), rel: "translation" }, { abs: join(root, "conversion"), rel: "conversion" }],
    root,
  );
}

describe("FsConfigFileStore", () => {
  it("lists non-.example. files with repo-relative paths", async () => {
    const files = await store().list();
    expect(files.map((f) => f.path).sort()).toEqual(["conversion/announcement.md", "translation/glossary.json"]);
    expect(files.find((f) => f.path === "conversion/announcement.md")!.content).toBe("# 공지");
  });

  it("write creates the file under the repo root", async () => {
    await store().write("translation/tm.json", "[1]");
    expect(await readFile(join(root, "translation", "tm.json"), "utf8")).toBe("[1]");
  });

  it("backup copies the current set into destDir", async () => {
    const dest = join(root, "output", "archive", "steering-x");
    await store().backup(dest);
    expect(await readFile(join(dest, "translation", "glossary.json"), "utf8")).toBe("[]");
    expect(await readFile(join(dest, "conversion", "announcement.md"), "utf8")).toBe("# 공지");
  });
});
```

- [ ] **Step 3: Run to verify it fails.**

- [ ] **Step 4: Implement** `src/adapters/store/FsConfigFileStore.ts`

```ts
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigFile } from "../../domain/config/bundle";
import type { ConfigFileStore } from "../../ports/ConfigFileStore";

const isExample = (name: string) => name.includes(".example.");

export class FsConfigFileStore implements ConfigFileStore {
  constructor(
    private readonly dirs: { abs: string; rel: string }[],
    private readonly repoRoot: string,
  ) {}

  async list(): Promise<ConfigFile[]> {
    const out: ConfigFile[] = [];
    for (const d of this.dirs) {
      for (const entry of await readdir(d.abs, { withFileTypes: true })) {
        if (!entry.isFile() || isExample(entry.name)) continue;
        const content = await readFile(join(d.abs, entry.name), "utf8");
        out.push({ path: `${d.rel}/${entry.name}`, content });
      }
    }
    return out;
  }

  async write(path: string, content: string): Promise<void> {
    const abs = join(this.repoRoot, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async backup(destDir: string): Promise<void> {
    for (const f of await this.list()) {
      const abs = join(destDir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }
  }
}
```

- [ ] **Step 5: Run to verify pass. Commit** `git commit -m "feat(config): FsConfigFileStore — list/write/backup"`.

---

## Task 4: `PushConfig` + `PullConfig` use-cases

**Files:** Create `src/app/PushConfig.ts`, `src/app/PullConfig.ts`; Test `tests/app/pushConfig.test.ts`, `tests/app/pullConfig.test.ts`

**Interfaces:**
- Consumes: `ConfigFileStore`, `ConfigDrive`, `assembleConfigBundle`/`parseConfigBundle`.
- Produces: `PushConfig.run(folderId) → { name; id; count }`; `PullConfig.run(folderId, { dryRun? }) → PullResult | undefined`.

- [ ] **Step 1: Write the failing tests**

`tests/app/pushConfig.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PushConfig } from "../../src/app/PushConfig";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { parseConfigBundle } from "../../src/domain/config/bundle";

const files: ConfigFileStore = {
  list: async () => [{ path: "translation/tm.json", content: "[1]" }],
  write: async () => {}, backup: async () => {},
};

describe("PushConfig", () => {
  it("bundles the file set and uploads one timestamped snapshot", async () => {
    const uploads: { name: string; content: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "F1" }; },
      latest: async () => undefined, download: async () => "",
    };
    const res = await new PushConfig(files, drive, () => "2026-07-28T00:00:00.000Z").run("FOLDER");
    expect(res).toEqual({ name: "steering-config-2026-07-28T00-00-00-000Z.json", id: "F1", count: 1 });
    expect(uploads).toHaveLength(1);
    expect(parseConfigBundle(uploads[0].content)).toEqual([{ path: "translation/tm.json", content: "[1]" }]);
  });
});
```

`tests/app/pullConfig.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PullConfig } from "../../src/app/PullConfig";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { assembleConfigBundle } from "../../src/domain/config/bundle";

function fakeFiles(current: { path: string; content: string }[]) {
  const events: string[] = [];
  const written: { path: string; content: string }[] = [];
  const store: ConfigFileStore = {
    list: async () => current,
    write: async (path, content) => { events.push(`write:${path}`); written.push({ path, content }); },
    backup: async (dest) => { events.push(`backup:${dest}`); },
  };
  return { store, events, written };
}
function driveWith(bundle: string): ConfigDrive {
  return { upload: async () => ({ id: "x" }), latest: async () => ({ id: "L1", name: "steering-config-x.json" }), download: async () => bundle };
}

const bundle = assembleConfigBundle([{ path: "translation/tm.json", content: "NEW" }], () => "t");

describe("PullConfig", () => {
  it("backs up before writing, then writes each pulled file", async () => {
    const f = fakeFiles([{ path: "translation/tm.json", content: "OLD" }]);
    const res = await new PullConfig(f.store, driveWith(bundle), "/arch", () => "2026-07-28T00-00-00").run("FOLDER");
    expect(f.events[0]).toMatch(/^backup:/); // backup precedes writes
    expect(f.events).toContain("write:translation/tm.json");
    expect(res!.pulled).toBe(1);
    expect(res!.changes).toEqual([{ path: "translation/tm.json", kind: "modified" }]);
  });

  it("--dry-run writes nothing and reports the change list", async () => {
    const f = fakeFiles([]);
    const res = await new PullConfig(f.store, driveWith(bundle), "/arch").run("FOLDER", { dryRun: true });
    expect(f.written).toHaveLength(0);
    expect(res!.dryRun).toBe(true);
    expect(res!.changes).toEqual([{ path: "translation/tm.json", kind: "new" }]);
  });

  it("returns undefined when there is no snapshot", async () => {
    const f = fakeFiles([]);
    const drive: ConfigDrive = { upload: async () => ({ id: "x" }), latest: async () => undefined, download: async () => "" };
    expect(await new PullConfig(f.store, drive, "/arch").run("FOLDER")).toBeUndefined();
    expect(f.written).toHaveLength(0);
  });

  it("aborts (no writes) if the backup fails", async () => {
    const f = fakeFiles([]);
    f.store.backup = async () => { throw new Error("disk full"); };
    await expect(new PullConfig(f.store, driveWith(bundle), "/arch").run("FOLDER")).rejects.toThrow(/disk full/);
    expect(f.written).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** `src/app/PushConfig.ts`

```ts
import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { assembleConfigBundle } from "../domain/config/bundle";

export class PushConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(folderId: string): Promise<{ name: string; id: string; count: number }> {
    const files = await this.files.list();
    const bundle = assembleConfigBundle(files, this.now);
    const name = `steering-config-${this.now().replace(/[:.]/g, "-")}.json`;
    const { id } = await this.drive.upload(folderId, name, bundle);
    return { name, id, count: files.length };
  }
}
```

and `src/app/PullConfig.ts`

```ts
import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { parseConfigBundle } from "../domain/config/bundle";

export interface PullChange {
  path: string;
  kind: "new" | "modified" | "same";
}
export interface PullResult {
  pulled: number;
  backupDir?: string;
  dryRun: boolean;
  changes: PullChange[];
}

export class PullConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly archiveDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(folderId: string, opts: { dryRun?: boolean } = {}): Promise<PullResult | undefined> {
    const latest = await this.drive.latest(folderId, "steering-config-");
    if (!latest) return undefined;
    const incoming = parseConfigBundle(await this.drive.download(latest.id));
    const current = new Map((await this.files.list()).map((f) => [f.path, f.content]));
    const changes: PullChange[] = incoming.map((f) => ({
      path: f.path,
      kind: !current.has(f.path) ? "new" : current.get(f.path) === f.content ? "same" : "modified",
    }));

    if (opts.dryRun) return { pulled: 0, dryRun: true, changes };

    const backupDir = `${this.archiveDir}/steering-${this.now().replace(/[:.]/g, "-")}`;
    await this.files.backup(backupDir); // before any write — a failure here aborts the pull
    for (const f of incoming) await this.files.write(f.path, f.content);
    return { pulled: incoming.length, backupDir, dryRun: false, changes };
  }
}
```

- [ ] **Step 4: Run to verify pass. Commit** `git commit -m "feat(config): PushConfig + PullConfig use-cases"`.

---

## Task 5: CLIs + config loader + provisioning + docs

**Files:** Create `src/cli/config-push.ts`, `src/cli/config-pull.ts`; Modify `src/config.ts`, `package.json`, `.env.example`, `CHANGELOG.md`, `docs/ko/capabilities.md`

**Interfaces:** Consumes everything above + `createGoogleAuth`, `loadGoogleAuthConfig`, `GoogleDriveProvisioner`, `paths`.

- [ ] **Step 1: Config loader** — add to `src/config.ts`:

```ts
export function loadGoogleConfigFolder(): string | undefined {
  return process.env.GDRIVE_CONFIG_FOLDER_ID?.trim() || undefined;
}
```

- [ ] **Step 2: Implement `src/cli/config-push.ts`**

```ts
import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { FsConfigFileStore } from "../adapters/store/FsConfigFileStore";
import { PushConfig } from "../app/PushConfig";
import { loadGoogleAuthConfig, loadGoogleConfigFolder } from "../config";
import { paths, REPO_ROOT } from "../paths";

const CONFIG_FOLDER_NAME = "Mantle KR Herald — Steering Config";
const auth = await createGoogleAuth(loadGoogleAuthConfig());

let folderId = loadGoogleConfigFolder();
if (!folderId) {
  const prov = new GoogleDriveProvisioner(auth);
  const found = (await prov.findFolder(CONFIG_FOLDER_NAME)) ?? (await prov.createFolder(CONFIG_FOLDER_NAME));
  folderId = found.id;
  console.log(`provisioned config folder "${found.name}" (${found.id})`);
  console.log(`add this to your .env:  GDRIVE_CONFIG_FOLDER_ID=${found.id}`);
}

const files = new FsConfigFileStore(
  [{ abs: paths.translationConfigDir, rel: "translation" }, { abs: paths.conversionConfigDir, rel: "conversion" }],
  REPO_ROOT,
);
const res = await new PushConfig(files, new GoogleConfigDrive(auth)).run(folderId);
console.log(`pushed ${res.count} file(s) → ${res.name} (${res.id})`);
```

(`REPO_ROOT` is an exported const in `src/paths.ts` — `resolve(dirname(fileURLToPath(import.meta.url)), "..")`; the `paths` object has no `repoRoot` key.)

- [ ] **Step 3: Implement `src/cli/config-pull.ts`**

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { FsConfigFileStore } from "../adapters/store/FsConfigFileStore";
import { PullConfig } from "../app/PullConfig";
import { loadGoogleAuthConfig, loadGoogleConfigFolder } from "../config";
import { paths, REPO_ROOT } from "../paths";

const folderId = loadGoogleConfigFolder();
if (!folderId) throw new Error("Set GDRIVE_CONFIG_FOLDER_ID (run `pnpm config:push` once to provision it).");

const dryRun = process.argv.includes("--dry-run");
const auth = await createGoogleAuth(loadGoogleAuthConfig());
const files = new FsConfigFileStore(
  [{ abs: paths.translationConfigDir, rel: "translation" }, { abs: paths.conversionConfigDir, rel: "conversion" }],
  REPO_ROOT,
);

const res = await new PullConfig(files, new GoogleConfigDrive(auth), paths.archiveDir).run(folderId, { dryRun });
if (!res) {
  console.log("no config snapshot on Drive — run `pnpm config:push` first");
} else if (res.dryRun) {
  const changed = res.changes.filter((c) => c.kind !== "same");
  console.log(changed.length === 0 ? "up to date (no changes)" : changed.map((c) => `  ${c.kind}: ${c.path}`).join("\n"));
} else {
  console.log(`pulled ${res.pulled} file(s) — backed up current → ${res.backupDir}`);
}
```

Use `argValue` only if you prefer it over `process.argv.includes` for `--dry-run`; either is fine (the file already imports `argValue` — drop the import if unused).

- [ ] **Step 4: Scripts** — `package.json` (near `config:init`):

```json
"config:push": "tsx --env-file-if-exists=.env src/cli/config-push.ts",
"config:pull": "tsx --env-file-if-exists=.env src/cli/config-pull.ts",
```

- [ ] **Step 5: `.env.example`** — add under the Google section:

```bash
# [OPTIONAL] Steering-config backup/share folder (pnpm config:push/pull). `config:push`
# provisions it and prints the id on first run if this is empty.
GDRIVE_CONFIG_FOLDER_ID=
```

- [ ] **Step 6: Typecheck** — `pnpm exec tsc --noEmit`.

- [ ] **Step 7: Live smoke test** (writes to the real Drive — cloud creds present)

Run: `pnpm config:push` → prints `pushed 15 file(s) → steering-config-<stamp>.json (<id>)` (and, on first run, the folder id to add to `.env` — add it). Then `pnpm config:pull --dry-run` → prints `up to date (no changes)` (or the change list). Record the output in the report. Do NOT commit the printed folder id.

- [ ] **Step 8: Docs** — `CHANGELOG.md` `[Unreleased] → Added` (config:push/pull, the bundle, single-maintainer, pull backs up first); `docs/ko/capabilities.md` add the two commands (steering backup/share; match tone). Reference `docs/superpowers/specs/2026-07-28-config-sync-design.md`.

- [ ] **Step 9: Full suite + commit**

```bash
pnpm test
git add src/cli/config-push.ts src/cli/config-pull.ts src/config.ts package.json .env.example CHANGELOG.md docs/ko/capabilities.md
git commit -m "feat(config): config:push/pull CLIs + folder provisioning + docs"
```

Expected: full suite green.

---

## Self-Review

**1. Spec coverage:** Decision 1 (push snapshot / pull latest) → Tasks 4+5. Decision 2 (JSON manifest of the dir-scanned non-example set) → Task 1 bundle + Task 3 `list`. Decision 3 (timestamped snapshots, pull takes newest) → Task 4 `PushConfig` name + `latest`. Decision 4 (pull backs up first, `--dry-run`, abort-on-backup-failure) → Task 4 `PullConfig` + Task 5 CLI. Decision 5 (GoogleConfigDrive upload/list/download + auto-provisioned folder) → Task 2 + Task 5. Error handling (unset folder, empty snapshot, bad bundle, backup-first) → Task 4 + Task 5. Every spec decision maps to a step.

**2. Placeholder scan:** No TBD/TODO. The repo-root symbol was verified against `src/paths.ts` — it is the exported `REPO_ROOT` const (not `paths.repoRoot`), and the CLI code imports it accordingly.

**3. Type consistency:** `ConfigFile { path, content }` (Task 1) is consumed by `ConfigFileStore` (Task 3), the bundle (Task 1), and the use-cases (Task 4). `ConfigDrive.{upload,latest,download}` (Task 2 port) is implemented by `GoogleConfigDrive` (Task 2) and consumed by `PushConfig`/`PullConfig` (Task 4). `PullResult`/`PullChange` (Task 4) are consumed by the CLI (Task 5). Snapshot name `steering-config-<stamp>.json` and the `latest(folderId, "steering-config-")` prefix agree between `PushConfig` and the CLI. `now()` is injected in the use-cases (deterministic tests) and defaulted in the CLIs.
