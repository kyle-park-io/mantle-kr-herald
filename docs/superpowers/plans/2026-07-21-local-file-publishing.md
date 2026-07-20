# Local File Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `HERALD_STORAGE_MODE=local` write the publish artifact to `output/publish/local/` instead of skipping publication, so the pipeline produces a readable document without any cloud account.

**Architecture:** `DriveUploader` is already a port and `PublishTranslations` takes `DriveUploader[]`, so the filesystem becomes one more "drive". A new `LocalFileUploader` reuses the renderers, the use-case, the sync ledger, `isStale`, failure isolation, and the dashboard's counters unchanged. Uploader construction — currently duplicated between `publish.ts` and `serve.ts` — moves into one `src/cli/uploaders.ts`.

**Tech Stack:** TypeScript (ESM, hexagonal: domain/ports/adapters/app/cli), `zod` as the only runtime dependency, native `fetch`, vitest, React + Vite + Tailwind v4 for the dashboard (build-time devDeps only).

**Spec:** `docs/superpowers/specs/2026-07-21-local-file-publishing-design.md`

## Global Constraints

- **Runtime dependencies stay `zod`-only.** Do not add a package to `dependencies` for any reason in this plan. Use `node:fs/promises`, `node:path`, `node:os`.
- **Code and comments in English. Korean documentation stays Korean** (`docs/ko/**`, `.env.example` stays English — it is developer-facing config).
- **`src/paths.ts` is the single source of truth for artifact paths.** Never write a bare `"output/..."` string literal.
- **Valid publish targets come from one exported constant.** Usage strings and error messages are interpolated from it, never hardcoded — PR #33 fixed exactly this bug for `ConversionType`.
- **`main` is branch-protected.** Work on `feat/local-file-publishing` (already created and holding the spec commit); integration is by PR.
- Verification commands for every task: `pnpm test`, `pnpm typecheck`, and — only for tasks touching `web/` — `pnpm typecheck:web`.
- The existing `tests/app/publishTranslations.test.ts` must keep passing **untouched**. If a task seems to require editing it, the use-case was not actually reused — stop and reconsider.

---

### Task 1: Extract `writeTextFileAtomic`

`writeJsonFileAtomic` calls `JSON.stringify` internally, so markdown cannot use it. Split the atomic-write mechanics out. This keeps published markdown on the same `.tmp-<pid>-<ms>-<uuid>` naming convention that `isStrandedTempFile` already matches, so `pnpm clean` sweeps interrupted writes with no new rule.

**Files:**
- Modify: `src/shared/store/jsonFile.ts:20-26`
- Test: `tests/shared/store/jsonFile.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `writeTextFileAtomic(dir: string, path: string, text: string): Promise<void>` — creates `dir` recursively, writes `text` to a temp sibling, renames over `path`. `writeJsonFileAtomic(dir: string, path: string, data: unknown): Promise<void>` keeps its exact existing signature and behaviour (2-space JSON + trailing newline).

- [ ] **Step 1: Write the failing test**

Create or append to `tests/shared/store/jsonFile.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTextFileAtomic, writeJsonFileAtomic } from "../../../src/shared/store/jsonFile";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jsonfile-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTextFileAtomic", () => {
  it("writes text verbatim, without JSON encoding it", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "# 제목\n\n본문\n");
    expect(await readFile(path, "utf8")).toBe("# 제목\n\n본문\n");
  });

  it("creates missing parent directories", async () => {
    const nested = join(dir, "a", "b");
    const path = join(nested, "doc.md");
    await writeTextFileAtomic(nested, path, "hi");
    expect(await readFile(path, "utf8")).toBe("hi");
  });

  it("leaves no temp file behind on success", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "hi");
    expect(await readdir(dir)).toEqual(["doc.md"]);
  });

  it("overwrites an existing file", async () => {
    const path = join(dir, "doc.md");
    await writeTextFileAtomic(dir, path, "old");
    await writeTextFileAtomic(dir, path, "new");
    expect(await readFile(path, "utf8")).toBe("new");
  });
});

describe("writeJsonFileAtomic", () => {
  it("still writes 2-space JSON with a trailing newline", async () => {
    const path = join(dir, "data.json");
    await writeJsonFileAtomic(dir, path, { a: 1 });
    expect(await readFile(path, "utf8")).toBe('{\n  "a": 1\n}\n');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/shared/store/jsonFile.test.ts`
Expected: FAIL — `writeTextFileAtomic` is not exported from `src/shared/store/jsonFile.ts`.

- [ ] **Step 3: Implement**

In `src/shared/store/jsonFile.ts`, replace the existing `writeJsonFileAtomic` (lines 19-26) with:

```ts
/** Atomic write: temp file in the same dir + rename over the target. */
export async function writeTextFileAtomic(dir: string, path: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmpPath, text, "utf8");
  await rename(tmpPath, path);
}

/** Atomic write of 2-space JSON with a trailing newline. */
export async function writeJsonFileAtomic(dir: string, path: string, data: unknown): Promise<void> {
  await writeTextFileAtomic(dir, path, `${JSON.stringify(data, null, 2)}\n`);
}
```

The imports at the top of the file (`mkdir`, `readFile`, `rename`, `writeFile`, `randomUUID`) are already correct — do not change them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — the new file passes and every pre-existing store test still passes (they all go through `writeJsonFileAtomic`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/store/jsonFile.ts tests/shared/store/jsonFile.test.ts
git commit -m "refactor(store): extract writeTextFileAtomic from writeJsonFileAtomic"
```

---

### Task 2: `LocalFileUploader`

The adapter itself, plus the regression invariant that motivated its `update()` contract.

**Files:**
- Create: `src/adapters/drive/LocalFileUploader.ts`
- Test: `tests/adapters/drive/localFileUploader.test.ts`

**Interfaces:**
- Consumes: `writeTextFileAtomic` from Task 1. `DriveUploader` (`src/ports/DriveUploader.ts`), `UploadRequest`/`UploadResult`/`FolderKind` (`src/domain/publish/publishModels.ts`).
- Produces: `class LocalFileUploader implements DriveUploader`, constructed as `new LocalFileUploader(rootDir: string)`, with `readonly name = "local"`. `upload(req)` and `update(remoteId, req)` both resolve to `{ id, name }` where **`id` is the path relative to `rootDir`** (e.g. `approved/2026-07-21-foo-x-1.md`) and `url` is omitted.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/drive/localFileUploader.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileUploader } from "../../../src/adapters/drive/LocalFileUploader";
import { isStrandedTempFile } from "../../../src/storage/retention";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "localpub-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalFileUploader", () => {
  it("is named local", () => {
    expect(new LocalFileUploader(root).name).toBe("local");
  });

  it("writes a review doc under review/ and returns a rootDir-relative id", async () => {
    const uploader = new LocalFileUploader(root);

    const result = await uploader.upload({ name: "x-1.md", content: "# hi", folder: "review" });

    expect(result).toEqual({ id: join("review", "x-1.md"), name: "x-1.md" });
    expect(await readFile(join(root, "review", "x-1.md"), "utf8")).toBe("# hi");
  });

  it("writes an approved doc under approved/", async () => {
    const uploader = new LocalFileUploader(root);
    await uploader.upload({ name: "x-2.md", content: "ko", folder: "approved" });
    expect(await readFile(join(root, "approved", "x-2.md"), "utf8")).toBe("ko");
  });

  it("overwrites in place when the filename did not change", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "x-1.md", content: "old", folder: "approved" });

    const second = await uploader.update(first.id, { name: "x-1.md", content: "new", folder: "approved" });

    expect(second.id).toBe(first.id);
    expect(await readFile(join(root, "approved", "x-1.md"), "utf8")).toBe("new");
    expect(await readdir(join(root, "approved"))).toEqual(["x-1.md"]);
  });

  it("deletes the old file when the filename changed, leaving exactly one document", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "2026-07-15-x-1.md", content: "old", folder: "approved" });

    const second = await uploader.update(first.id, { name: "2026-07-21-x-1.md", content: "new", folder: "approved" });

    expect(second.id).toBe(join("approved", "2026-07-21-x-1.md"));
    expect(await readdir(join(root, "approved"))).toEqual(["2026-07-21-x-1.md"]);
    expect(await readFile(join(root, "approved", "2026-07-21-x-1.md"), "utf8")).toBe("new");
  });

  it("restores the document instead of failing when the old file was deleted by hand", async () => {
    const uploader = new LocalFileUploader(root);
    const first = await uploader.upload({ name: "2026-07-15-x-1.md", content: "old", folder: "approved" });
    await rm(join(root, first.id));

    const second = await uploader.update(first.id, { name: "2026-07-21-x-1.md", content: "new", folder: "approved" });

    expect(await readFile(join(root, second.id), "utf8")).toBe("new");
  });

  it("leaves debris that pnpm clean recognises if a write is interrupted", async () => {
    // The uploader renames a temp sibling over the target; a crash between write and rename
    // strands a file matching the convention clean.ts sweeps.
    const uploader = new LocalFileUploader(root);
    await uploader.upload({ name: "x-1.md", content: "c", folder: "approved" });
    const stranded = `x-1.md.tmp-${process.pid}-${Date.now()}-00000000-0000-0000-0000-000000000000`;
    await writeFile(join(root, "approved", stranded), "partial", "utf8");

    expect(isStrandedTempFile(stranded)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/adapters/drive/localFileUploader.test.ts`
Expected: FAIL — cannot resolve `src/adapters/drive/LocalFileUploader`.

- [ ] **Step 3: Implement**

Create `src/adapters/drive/LocalFileUploader.ts`:

```ts
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { writeTextFileAtomic } from "../../shared/store/jsonFile";
import type { UploadRequest, UploadResult } from "../../domain/publish/publishModels";
import type { DriveUploader } from "../../ports/DriveUploader";

/**
 * The filesystem as a publish target, so `local` storage mode produces the same human-readable
 * document Drive gets instead of skipping publication. Folder kinds map to subdirectories, which
 * is why this needs no configuration where Google and Lark need folder ids.
 */
export class LocalFileUploader implements DriveUploader {
  readonly name = "local";

  constructor(private readonly rootDir: string) {}

  async upload(req: UploadRequest): Promise<UploadResult> {
    return this.write(req);
  }

  /**
   * Moves rather than overwrites. `publishFileName` embeds approvedAt's date, so re-approving on a
   * later day changes the filename — a plain overwrite would leave the old file behind as a
   * duplicate that nothing on disk distinguishes from the current one. Google avoids this by
   * PATCHing a file id; addressing by path means the local equivalent is deleting the old path.
   *
   * `remoteId` is a path relative to rootDir, as returned by upload().
   */
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    const result = await this.write(req);
    const oldPath = resolve(this.rootDir, remoteId);
    const newPath = resolve(this.rootDir, result.id);
    if (oldPath !== newPath) {
      await unlink(oldPath).catch((err: NodeJS.ErrnoException) => {
        // Moved or deleted by hand is not a failure — the write above already restored the current
        // content. Anything else (a permissions problem) is real and must surface.
        if (err.code !== "ENOENT") throw err;
      });
    }
    return result;
  }

  /** `url` is omitted: the dashboard is served over http, where browsers block file:// links. */
  private async write(req: UploadRequest): Promise<UploadResult> {
    const relative = join(req.folder, req.name);
    const full = join(this.rootDir, relative);
    await writeTextFileAtomic(dirname(full), full, req.content);
    return { id: relative, name: req.name };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run tests/adapters/drive/localFileUploader.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing regression-invariant test**

This is the scenario that motivated the whole `update()` contract. Create `tests/app/publishLocalRoundTrip.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileUploader } from "../../src/adapters/drive/LocalFileUploader";
import { PublishTranslations } from "../../src/app/PublishTranslations";
import { publishFileName } from "../../src/domain/publish/renderers";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { PublishStore } from "../../src/ports/PublishStore";
import { entryKey, type SyncEntry } from "../../src/domain/publish/syncLedger";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roundtrip-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class InMemoryPublishStore implements PublishStore {
  public entries: SyncEntry[] = [];
  async listEntries() {
    return this.entries;
  }
  async record(entry: SyncEntry) {
    this.entries = this.entries.filter((e) => entryKey(e) !== entryKey(entry));
    this.entries.push(entry);
  }
}

function store(list: Translation[]): TranslationStore {
  return { loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set() };
}

describe("publishing to the local filesystem across a re-approval", () => {
  it("leaves exactly one document when re-approval changes the filename", async () => {
    const approved: Translation = {
      itemId: "x:1",
      source: "x",
      sourceText: "hello world from mantle",
      koreanText: "안녕하세요",
      status: "approved",
      translatedAt: "2026-07-15T00:00:00.000Z",
      approvedAt: "2026-07-15T00:00:00.000Z",
    };
    const ledger = new InMemoryPublishStore();
    const uploader = new LocalFileUploader(root);

    const first = await new PublishTranslations(store([approved]), [uploader], ledger).run();
    expect(first).toMatchObject({ uploaded: 1, updated: 0, failed: 0 });
    expect(await readdir(join(root, "approved"))).toEqual([publishFileName(approved)]);

    // Edited and re-approved six days later: koreanText changes (new hash → stale) and approvedAt
    // changes (new filename).
    const reapproved: Translation = {
      ...approved,
      koreanText: "안녕하세요, 수정본입니다",
      approvedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(publishFileName(reapproved)).not.toBe(publishFileName(approved));

    const second = await new PublishTranslations(store([reapproved]), [uploader], ledger).run();

    expect(second).toMatchObject({ uploaded: 0, updated: 1, failed: 0 });
    expect(await readdir(join(root, "approved"))).toEqual([publishFileName(reapproved)]);
    expect(await readFile(join(root, "approved", publishFileName(reapproved)), "utf8")).toContain("수정본");
    expect(ledger.entries).toHaveLength(1);
  });

  it("does nothing on a re-run when the content is unchanged", async () => {
    const approved: Translation = {
      itemId: "x:2",
      source: "x",
      sourceText: "unchanged",
      koreanText: "그대로",
      status: "approved",
      translatedAt: "2026-07-15T00:00:00.000Z",
      approvedAt: "2026-07-15T00:00:00.000Z",
    };
    const ledger = new InMemoryPublishStore();
    const uploader = new LocalFileUploader(root);

    await new PublishTranslations(store([approved]), [uploader], ledger).run();
    const second = await new PublishTranslations(store([approved]), [uploader], ledger).run();

    expect(second).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
  });
});
```

- [ ] **Step 6: Run it**

Run: `pnpm vitest run tests/app/publishLocalRoundTrip.test.ts`
Expected: PASS with no production-code change — the use-case, ledger, and `isStale` were reused as designed. **If it fails, do not edit `PublishTranslations`**; the failure means `LocalFileUploader` does not honour the port contract. Fix the adapter.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/drive/LocalFileUploader.ts tests/adapters/drive/localFileUploader.test.ts tests/app/publishLocalRoundTrip.test.ts
git commit -m "feat(publish): add LocalFileUploader writing publish docs to disk

update() moves rather than overwrites: publishFileName embeds approvedAt's
date, so re-approving on a later day changes the filename and a plain
overwrite would strand the old file as an indistinguishable duplicate."
```

---

### Task 3: Target resolution and uploader construction

One composition point for both CLIs. `resolveTargets` is pure so it can be tested exhaustively without mocking auth; `createUploaders` does the I/O.

**Files:**
- Create: `src/cli/uploaders.ts`
- Modify: `src/paths.ts:28` (add one entry)
- Test: `tests/cli/uploaders.test.ts`

**Interfaces:**
- Consumes: `LocalFileUploader` from Task 2. `parseList` (`src/cli/args.ts`), `StorageMode` (`src/storage/mode.ts`), `paths` (`src/paths.ts`), the three config loaders in `src/config.ts`.
- Produces:
  - `paths.publishLocalDir: string` — `output/publish/local`
  - `ALL_TARGETS: readonly ["google", "lark", "local"]` and `type PublishTarget = (typeof ALL_TARGETS)[number]`
  - `TARGETS_USAGE: string` — `"google|lark|local"`, for usage strings
  - `defaultTarget(mode: StorageMode): PublishTarget`
  - `resolveTargets(raw: string | undefined, mode: StorageMode): PublishTarget[]` — expands `both`, de-duplicates, validates, throws on a cloud target in local mode
  - `createUploaders(targets: PublishTarget[]): Promise<DriveUploader[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/cli/uploaders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ALL_TARGETS, TARGETS_USAGE, defaultTarget, resolveTargets } from "../../src/cli/uploaders";

describe("defaultTarget", () => {
  it("defaults to local in local mode", () => {
    expect(defaultTarget("local")).toBe("local");
  });

  it("defaults to google in cloud mode, unchanged from before", () => {
    expect(defaultTarget("cloud")).toBe("google");
  });
});

describe("resolveTargets", () => {
  it("uses the mode's default when no flag was given", () => {
    expect(resolveTargets(undefined, "local")).toEqual(["local"]);
    expect(resolveTargets(undefined, "cloud")).toEqual(["google"]);
  });

  it("parses a comma-separated list", () => {
    expect(resolveTargets("google,local", "cloud")).toEqual(["google", "local"]);
  });

  it("keeps both as an alias for google,lark", () => {
    expect(resolveTargets("both", "cloud")).toEqual(["google", "lark"]);
  });

  it("de-duplicates when both and an explicit target overlap", () => {
    expect(resolveTargets("both,google", "cloud")).toEqual(["google", "lark"]);
  });

  it("allows local alongside cloud targets in cloud mode", () => {
    expect(resolveTargets("both,local", "cloud")).toEqual(["google", "lark", "local"]);
  });

  it("rejects a cloud target in local mode instead of silently skipping", () => {
    expect(() => resolveTargets("google", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
    expect(() => resolveTargets("lark", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
    expect(() => resolveTargets("both", "local")).toThrow(/HERALD_STORAGE_MODE=cloud/);
  });

  it("rejects an unknown target and names the valid ones", () => {
    expect(() => resolveTargets("dropbox", "cloud")).toThrow(/dropbox/);
    expect(() => resolveTargets("dropbox", "cloud")).toThrow(/google\|lark\|local/);
  });

  it("derives the usage string from ALL_TARGETS rather than hardcoding it", () => {
    expect(TARGETS_USAGE).toBe(ALL_TARGETS.join("|"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/cli/uploaders.test.ts`
Expected: FAIL — cannot resolve `src/cli/uploaders`.

- [ ] **Step 3: Add the path**

In `src/paths.ts`, add one entry immediately after the `publishDir` line:

```ts
  publishDir: join(OUTPUT_DIR, "publish"),
  publishLocalDir: join(OUTPUT_DIR, "publish", "local"),
```

- [ ] **Step 4: Implement `src/cli/uploaders.ts`**

```ts
import { parseList } from "./args";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LocalFileUploader } from "../adapters/drive/LocalFileUploader";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";
import type { StorageMode } from "../storage/mode";
import { paths } from "../paths";

export const ALL_TARGETS = ["google", "lark", "local"] as const;
export type PublishTarget = (typeof ALL_TARGETS)[number];

/** Usage/error text is interpolated from ALL_TARGETS: a hardcoded list goes stale invisibly. */
export const TARGETS_USAGE = ALL_TARGETS.join("|");

const CLOUD_TARGETS: readonly PublishTarget[] = ["google", "lark"];

function isTarget(value: string): value is PublishTarget {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

/** local mode publishes to disk; cloud mode keeps Google as the historical default. */
export function defaultTarget(mode: StorageMode): PublishTarget {
  return mode === "local" ? "local" : "google";
}

/**
 * Expand `--target`. `both` predates the third target and is kept as an alias so existing usage
 * does not break. A cloud target in local mode throws rather than skipping: the credentials are
 * absent so it would fail anyway, and hiding that behind exit 0 is the failure this whole change
 * corrects.
 */
export function resolveTargets(raw: string | undefined, mode: StorageMode): PublishTarget[] {
  const requested = parseList(raw) ?? [defaultTarget(mode)];
  const expanded = requested.flatMap((t) => (t === "both" ? ["google", "lark"] : [t]));

  const resolved: PublishTarget[] = [];
  for (const candidate of expanded) {
    if (!isTarget(candidate)) {
      throw new Error(`Unknown publish target: ${candidate} (expected ${TARGETS_USAGE}, or "both" for google,lark)`);
    }
    if (mode === "local" && CLOUD_TARGETS.includes(candidate)) {
      throw new Error(
        `--target ${candidate} needs HERALD_STORAGE_MODE=cloud (currently local). ` +
          `Use --target local to publish to ${paths.publishLocalDir}.`,
      );
    }
    if (!resolved.includes(candidate)) resolved.push(candidate);
  }
  return resolved;
}

/** The one place uploaders are constructed — shared by `drive:publish` and the dashboard. */
export async function createUploaders(targets: PublishTarget[]): Promise<DriveUploader[]> {
  const uploaders: DriveUploader[] = [];
  for (const target of targets) {
    if (target === "google") {
      const g = loadGoogleDriveConfig();
      const auth = await createGoogleAuth(loadGoogleAuthConfig());
      uploaders.push(new GoogleDriveUploader(auth, { review: g.reviewFolderId, approved: g.approvedFolderId }));
    } else if (target === "lark") {
      const l = loadLarkDriveConfig();
      const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
      uploaders.push(
        new LarkDriveUploader(auth, l.baseUrl, { review: l.reviewFolderToken, approved: l.approvedFolderToken }),
      );
    } else {
      uploaders.push(new LocalFileUploader(paths.publishLocalDir));
    }
  }
  return uploaders;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/cli/uploaders.test.ts && pnpm typecheck`
Expected: PASS — 10 tests, and the typecheck is clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/uploaders.ts src/paths.ts tests/cli/uploaders.test.ts
git commit -m "feat(cli): resolve publish targets in one place, add local target

--target becomes a comma list so a third target does not make 'both'
ambiguous; 'both' stays an alias for google,lark. A cloud target in local
mode throws instead of skipping."
```

---

### Task 4: Wire `drive:publish`

**Files:**
- Modify: `src/cli/publish.ts` (whole file)

**Interfaces:**
- Consumes: `resolveTargets`, `createUploaders`, `paths.publishLocalDir` from Task 3.
- Produces: no new exports. `pnpm drive:publish` runs in local mode and writes files.

- [ ] **Step 1: Replace the file**

Replace the entire contents of `src/cli/publish.ts` with:

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadStorageMode } from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import { paths } from "../paths";

// No skipIfLocal: in local mode publishing is not skipped, it targets the filesystem.
const targets = resolveTargets(argValue("--target"), loadStorageMode());
const uploaders = await createUploaders(targets);

const usecase = new PublishTranslations(
  new JsonTranslationStore(paths.translationsDir),
  uploaders,
  new JsonPublishStore(paths.publishDir),
);
const result = await usecase.run();
console.log(
  `published ${result.uploaded} new + ${result.updated} updated across ${uploaders.length} drive(s); ${result.failed} failure(s)`,
);
console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
if (targets.includes("local")) console.log(`  local files: ${paths.publishLocalDir}`);
for (const f of result.failures) console.error(`  ✗ ${f.key}: ${f.error}`);
if (result.failed > 0) process.exitCode = 1;
```

Note the removed imports: `skipIfLocal`, `HttpClient`, `LarkAuth`, `createGoogleAuth`, `GoogleDriveUploader`, `LarkDriveUploader`, the three config loaders, and the `DriveUploader` type all move into `uploaders.ts`.

- [ ] **Step 2: Verify the local path end to end by hand**

Run:

```bash
HERALD_STORAGE_MODE=local pnpm drive:publish
```

Expected: it does **not** print `drive:publish: local mode — skipped`. It prints a `published N new + M updated ...` line, a `by drive: {"local":N}` line, and a `local files: <abs path>/output/publish/local` line.

Then confirm files exist:

```bash
find output/publish/local -type f -name '*.md' | head
```

Expected: one `.md` per approved translation, under `output/publish/local/approved/`.

**These files are real artifacts of this repo's working tree, not test fixtures — leave them in place.** `output/` is git-ignored, so they will not appear in `git status`.

- [ ] **Step 3: Verify the refusal is loud**

Run:

```bash
HERALD_STORAGE_MODE=local pnpm drive:publish --target google
```

Expected: exit code 1 and a single `✖ --target google needs HERALD_STORAGE_MODE=cloud (currently local). Use --target local to publish to .../output/publish/local.` line (the `✖` prefix comes from `registerErrorHandler`).

- [ ] **Step 4: Run the suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/publish.ts
git commit -m "feat(cli): drive:publish writes to disk in local mode instead of skipping"
```

---

### Task 5: Dashboard backend — publish in local mode + `GET /api/config`

**Files:**
- Modify: `src/cli/serve.ts:32-52` (replace `uploadersFor`), `src/cli/serve.ts:20-23` (imports)
- Modify: `src/adapters/web/apiHandlers.ts:18-26` (`ApiDeps`), `:32-38` (add the config route), `:61-65` (publish route)
- Test: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `resolveTargets`, `createUploaders` from Task 3.
- Produces: `ApiDeps` gains `storageMode: StorageMode`. `ApiDeps.buildPublisher` widens to `(target: string | undefined) => Promise<PublishTranslations>`. New route `GET /api/config` → `200 { storageMode }`.

- [ ] **Step 1: Write the failing test**

In `tests/adapters/web/apiHandlers.test.ts`, add `storageMode: "cloud"` to the object returned by `makeDeps` (alongside `translationStore`, `saveTranslation`, `buildPublisher`, …), then append this describe block at the end of the file:

```ts
describe("GET /api/config", () => {
  it("reports the server's storage mode so the dashboard can pick a publish target", async () => {
    const res = await handleApi(makeDeps([]), "GET", "/api/config", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ storageMode: "cloud" });
  });

  it("reports local mode when the server is in local mode", async () => {
    const deps = { ...makeDeps([]), storageMode: "local" as const };
    const res = await handleApi(deps, "GET", "/api/config", undefined);
    expect(res.json).toEqual({ storageMode: "local" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — both new tests get `{ status: 404, json: { error: "not found" } }`. Note that vitest strips types rather than checking them, so the `storageMode` key that `ApiDeps` does not yet declare does **not** fail here; `pnpm typecheck` is what would catch it, and it is run in Step 5.

- [ ] **Step 3: Extend `ApiDeps` and add the route**

In `src/adapters/web/apiHandlers.ts`, add the import:

```ts
import type { StorageMode } from "../../storage/mode";
```

Change the `ApiDeps` interface (line 18) so `buildPublisher` widens and `storageMode` is added:

```ts
export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  buildPublisher: (target: string | undefined) => Promise<PublishTranslations>;
  storageMode: StorageMode;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
}
```

Immediately after the `if (segments[0] !== "api")` guard (line 34), add:

```ts
  // The frontend cannot know the server's storage mode, and it decides which publish targets to
  // offer — a local-mode dashboard defaulting to "google" would fail on every first click.
  if (method === "GET" && segments.length === 2 && segments[1] === "config") {
    return { status: 200, json: { storageMode: deps.storageMode } };
  }
```

Replace the publish route body (lines 61-65) so the default comes from the resolver rather than a hardcoded `"google"`:

```ts
  if (method === "POST" && segments.length === 2 && segments[1] === "publish") {
    const target = (body as { target?: string })?.target;
    const pub = await deps.buildPublisher(target);
    return { status: 200, json: await pub.run() };
  }
```

- [ ] **Step 4: Rewire `serve.ts`**

In `src/cli/serve.ts`, delete these imports: `GoogleDriveUploader`, `LarkDriveUploader`, `LarkAuth`, `HttpClient`, `createGoogleAuth`, `loadGoogleAuthConfig`, `loadGoogleDriveConfig`, `loadLarkDriveConfig`, `type DriveUploader`, and `assertCloudMode`. Keep `loadStorageMode`. Add:

```ts
import { createUploaders, resolveTargets } from "./uploaders";
```

Delete the whole `uploadersFor` function (lines 32-52) and replace the `deps` object's `buildPublisher` line so it reads:

```ts
const storageMode = loadStorageMode();

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  buildPublisher: async (target) =>
    new PublishTranslations(translationStore, await createUploaders(resolveTargets(target, storageMode)), publishStore),
  storageMode,
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore),
  approveRendering: new ApproveRendering(formattingStore),
};
```

`resolveTargets` throws on an invalid or mode-incompatible target, and `HttpServer` turns a thrown error into a 500 carrying the message — the same mechanism `assertCloudMode` relied on, so no server-lifecycle behaviour changes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/apiHandlers.ts src/cli/serve.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat(web): allow publishing in local mode, expose storage mode via GET /api/config"
```

---

### Task 6: Dashboard frontend — `PublishBar`

**Files:**
- Modify: `web/src/types.ts` (add `AppConfig`), `web/src/api.ts` (add `config`), `web/src/components/PublishBar.tsx` (whole file)

**Interfaces:**
- Consumes: `GET /api/config` from Task 5.
- Produces: no exports consumed by later tasks.

- [ ] **Step 1: Add the type**

In `web/src/types.ts`, append:

```ts
// Mirrors src/storage/mode.ts — keep in sync.
export type StorageMode = "local" | "cloud";

export interface AppConfig {
  storageMode: StorageMode;
}
```

- [ ] **Step 2: Add the API call**

In `web/src/api.ts`, extend the type import to include `AppConfig`:

```ts
import type { Translation, PublishResult, Rendering, ConversionType, Channel, AppConfig } from "./types";
```

and add this as the first entry of the `api` object:

```ts
  config: () => fetch("/api/config").then((r) => json<AppConfig>(r)),
```

- [ ] **Step 3: Replace `PublishBar`**

Replace the entire contents of `web/src/components/PublishBar.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { StorageMode } from "../types";

/** local mode publishes to disk, so offering a cloud target there would fail on every click. */
const targetsFor = (mode: StorageMode): string[] =>
  mode === "local" ? ["local"] : ["google", "lark", "both", "local"];

export function PublishBar() {
  const [mode, setMode] = useState<StorageMode | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .config()
      .then((c) => {
        setMode(c.storageMode);
        setTarget(targetsFor(c.storageMode)[0]);
      })
      .catch((e) => setResult(`오류: ${(e as Error).message ?? e}`));
  }, []);

  const publish = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.publish(target);
      setResult(`업로드 ${r.uploaded} · 갱신 ${r.updated} · 실패 ${r.failed}`);
    } catch (e) {
      setResult(`오류: ${(e as Error).message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <select
        className="text-neutral-900 text-sm rounded px-1.5 py-1"
        value={target}
        disabled={mode === null}
        onChange={(e) => setTarget(e.target.value)}
      >
        {mode !== null &&
          targetsFor(mode).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
      </select>
      <button
        className="px-3 py-1 rounded-md border border-white/30 text-sm disabled:opacity-50"
        disabled={busy || mode === null}
        onClick={publish}
      >
        발행 ⬆
      </button>
      {result && <span className="text-xs font-normal">{result}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck the frontend**

Run: `pnpm typecheck:web && pnpm build:web`
Expected: both succeed.

- [ ] **Step 5: Verify in the browser**

Run:

```bash
HERALD_STORAGE_MODE=local pnpm serve
```

Open `http://localhost:5757`. Expected: the target dropdown shows **only** `local` and is pre-selected; clicking `발행 ⬆` reports `업로드 N · 갱신 M · 실패 0` and does **not** produce an error about Google credentials. Stop the server afterwards.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/components/PublishBar.tsx
git commit -m "feat(web): pick publish targets from the server's storage mode"
```

---

### Task 7: Stop treating local mode as "publishing disabled" in `status`

**Files:**
- Modify: `src/status/sync.ts:44-52`
- Modify: `src/cli/status.ts:13` and `:30-40`
- Test: `tests/status/sync.test.ts:78-125` (the whole `formatSyncSummary` describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `formatSyncSummary(s: SyncCounts): string` — **the `mode` parameter is removed**.

**This is a removal, so the usual "write a failing test first" order is inverted.** A new one-argument test would pass against the current code — `mode` is optional and `undefined` already takes the warning branch. The tests that actually pin the behaviour being deleted are the *existing* ones, so the honest sequence is: confirm they pass (they document the wrong behaviour), delete the special case, watch them fail (proving the change landed), then replace them.

- [ ] **Step 1: Confirm the tests that document the current behaviour pass**

Run: `pnpm vitest run tests/status/sync.test.ts`
Expected: PASS, including `omits the warning marker and labels the line in local mode, even with unsynced work`. That test is the specification being removed — note that it passes now.

- [ ] **Step 2: Remove the special case**

In `src/status/sync.ts`, delete the `import type { StorageMode }` line at the top and replace `formatSyncSummary` with:

```ts
export function formatSyncSummary(s: SyncCounts): string {
  const parts = [`${s.published} published`];
  if (s.unsynced > 0) parts.push(`${s.unsynced} unsynced`);
  if (s.stale > 0) parts.push(`${s.stale} stale`);
  const warn = s.unsynced > 0 || s.stale > 0 ? "⚠ " : "";
  return `${warn}sync: ${parts.join(" · ")}`;
}
```

- [ ] **Step 3: Watch the old tests fail**

Run: `pnpm vitest run tests/status/sync.test.ts`
Expected: FAIL. `omits the warning marker and labels the line in local mode` fails because the line now carries `⚠` and no longer says `local mode`. The three tests that pass a mode argument (`"cloud"`, `undefined`, and the loop over all three) still pass at runtime — vitest strips types rather than checking them, so the now-extra argument is ignored. **This failure is the proof the behaviour changed**; do not skip observing it.

- [ ] **Step 4: Replace the test block**

In `tests/status/sync.test.ts`, replace the entire `describe("formatSyncSummary", ...)` block (from `describe("formatSyncSummary"` to the end of the file) with:

```ts
describe("formatSyncSummary", () => {
  it("stays quiet when everything is synced", () => {
    expect(formatSyncSummary({ published: 3, unsynced: 0, stale: 0 })).toContain("3 published");
    expect(formatSyncSummary({ published: 3, unsynced: 0, stale: 0 })).not.toContain("⚠");
  });

  it("warns when work is unsynced or stale", () => {
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 1 });
    expect(out).toContain("⚠");
    expect(out).toContain("2 unsynced");
    expect(out).toContain("1 stale");
  });

  it("no longer suppresses the warning or labels the line for local mode", () => {
    // local mode publishes to output/publish/local/, so unsynced work is a real backlog there
    // exactly as it is on Drive. The old special case hid it.
    const out = formatSyncSummary({ published: 1, unsynced: 2, stale: 0 });
    expect(out).toContain("⚠");
    expect(out).not.toContain("local mode");
    expect(out).not.toContain("publishing disabled");
  });
});
```

- [ ] **Step 5: Update the caller**

In `src/cli/status.ts`, delete the `import { tryLoadStorageMode } from "../config";` line and drop the second argument, so the closing call reads:

```ts
console.log(
  formatSyncSummary(
    syncSummary({
      translations,
      entries,
      render: (t) => (t.status === "approved" ? renderApproved(t) : renderReview(t)),
    }),
  ),
);
```

Leave `tryLoadStorageMode` in `src/config.ts` — `src/cli/doctor.ts:30` still uses it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `pnpm typecheck` is what catches any call site still passing the removed argument — vitest alone would not.

- [ ] **Step 7: Verify by hand**

Run: `HERALD_STORAGE_MODE=local pnpm status`
Expected: the sync line no longer contains `(local mode — publishing disabled)`. After Task 4's manual publish it should read `sync: N published` with no `⚠`.

- [ ] **Step 8: Commit**

```bash
git add src/status/sync.ts src/cli/status.ts tests/status/sync.test.ts
git commit -m "fix(status): warn on unsynced work in local mode too

Publishing happens in local mode now, so the special case that suppressed
the warning hid a real backlog."
```

---

### Task 8: Invert every "local means no publishing" claim

The documentation edits outnumber the code edits, and every location below was confirmed by grep. Skipping any of them leaves the repo asserting the behaviour this plan just removed.

**Files:**
- Modify: `docs/ko/artifacts.md` (§1 table, §2 table, §2 promotion steps, §3 command table, the `skipIfLocal` paragraph)
- Modify: `.env.example` (lines ~20-39, ~69)
- Modify: `docs/ko/quickstart.md:10, 40, 89-105`
- Modify: `docs/ko/capabilities.md:39, 70, 98`
- Modify: `docs/ko/team-runbook.md:25, 78-110`
- Modify: `docs/ko/review.md:87`
- Modify: `docs/ko/setup/README.md:17-20`
- Modify: `CHANGELOG.md` (`[Unreleased]`)

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1-7.
- Produces: nothing code-level.

- [ ] **Step 1: Re-read the shipped behaviour before writing about it**

Run:

```bash
grep -rn "skipIfLocal" src/
HERALD_STORAGE_MODE=local pnpm drive:publish --help 2>&1 | head -5
```

Expected: `skipIfLocal` now appears in `src/cli/skipIfLocal.ts` plus exactly **four** call sites (`drive-init`, `sheet-init`, `targets-list`, `history-record`) — `publish.ts` is gone from the list. Documentation must say four, not five.

- [ ] **Step 2: `docs/ko/artifacts.md`**

Make these edits (Korean, matching the surrounding tone):

1. **§1 저장 계층 table** — replace the last three rows (`작업 공간`, `기록의 원본`, `게시 이력`) with:

```markdown
| 작업 공간 | `output/` (`publish/local/` 제외) | 폐기 가능한 중간 산출물 | 무시됨 |
| **기록의 원본** — `cloud` 모드 | Google Drive / Lark Drive | 승인된 결과물, 영구 보존 | — |
| **기록의 원본** — `local` 모드 | `output/publish/local/{review,approved}/` | 승인된 결과물. 무시되는 트리에 있으므로 **백업은 사용자 책임** | 무시됨 |
| 게시 이력 | Google Sheet `history` 탭 | 게시 + 도달 기록 | — |
```

Then add one sentence under the table: `local` 모드에서는 `output/`이 통째로 "폐기 가능"하지 않습니다 — `output/publish/local/` 아래의 마크다운은 파이프라인이 만들어내는 **최종 산출물**이며, `pnpm clean`은 이 파일들을 지우지 않습니다(임시 파일 패턴만 청소).
2. **§2 mode table** — the `drive:publish, drive:init, sheet:init, targets:list, history:record` row must drop `drive:publish` and say **네 개**. Add a new row for `drive:publish`: `local`이면 `output/publish/local/{review,approved}/`에 마크다운 저장, `cloud`면 Drive 업로드.
3. **§2 `pnpm status` row** — remove the `(local mode — publishing disabled)` description; local now warns identically to cloud.
4. **§2 `skipIfLocal()` paragraph** — "다섯 개 CLI" → "네 개 CLI", and drop `src/cli/publish.ts` from the parenthesised list.
5. **§2 dashboard paragraph** — the sentence saying publishing is refused with a 500 in local mode is now wrong. Replace with: the dashboard publishes in local mode, and `GET /api/config`가 저장 모드를 알려줘 대상 선택지가 모드에 맞게 좁혀진다.
6. **§2 local → cloud 승격** — keep the steps, but add that 원장에 이미 `local` 행이 있어도 `google` 행은 별개 키라 승격 시 정상적으로 업로드된다.
7. **§3 명령어별 입출력 table** — the `pnpm drive:publish` row's "쓰는 것" gains `output/publish/local/{review,approved}/*.md` (local 모드), and "외부 시스템" becomes 모드에 따라 없음/Google Drive.

- [ ] **Step 3: `.env.example`**

In the `HERALD_STORAGE_MODE` block (lines ~18-39), rewrite the two mode descriptions and the never-inferred rationale:

```
#   local — everything stays under output/, including the published documents
#           (output/publish/local/{review,approved}/). **You own that tree**: it
#           is git-ignored, so nothing backs it up for you. Know what lives where
#           (docs/ko/artifacts.md) and run `pnpm archive` / `pnpm clean` to keep
#           it from growing without bound.
#   cloud — Google/Lark Drive becomes the record of truth; drive:publish uploads
#           there, the Sheet commands run, and section 3 becomes required.
#           output/ is still your working tree — the Drive copy is the record,
#           not a backup of it.
#
# Never inferred. An unset value fails loudly rather than guessing, because
# guessing wrong sends published work to the wrong place: a cloud operator would
# find their documents sitting in output/ instead of Drive, with drive:publish
# reporting success either way.
```

At line ~69, change the section 3 preamble: only four commands (`drive:init`, `sheet:init`, `targets:list`, `history:record`) skip with a message and exit 0 — `drive:publish` no longer does, because in local mode it targets the filesystem.

- [ ] **Step 4: `docs/ko/quickstart.md`**

- Line ~10: 클라우드 자격 증명이 선택이라는 문장은 유지하되, `local`에서도 발행 결과물이 `output/publish/local/`에 생긴다는 점을 덧붙입니다.
- Line ~40: 동일 취지.
- §5 (lines ~89-105): "지금까지는 원장이 비어 있으니(§2에서 `local` 모드로 지내는 동안 아무 것도 업로드된 적이 없으므로)" 문장이 **거짓이 됩니다.** `local` 행이 이미 있지만 `google` 행은 별개 키라 백로그 전체가 그대로 업로드된다고 고쳐 씁니다.

- [ ] **Step 5: `docs/ko/capabilities.md`**

- Line ~39 (파이프라인 다이어그램의 `[발행] pnpm drive:publish`): 대상이 Drive 또는 로컬 폴더임을 표시.
- Line ~70: "어떤 채널로도 자동 게시하지 않습니다" 는 그대로 참 — 발행 대상 설명만 보강.
- Line ~98 (D 행): "Google Drive와 Lark Drive에 마크다운으로 업로드" → 로컬 파일 저장도 포함.

- [ ] **Step 6: `docs/ko/team-runbook.md`**

- Line ~25: `local` 모드가 "개인 실습용"인 이유가 "로컬에만 쌓아 둔다"였습니다. 이제 실제 산출물이 남으므로, **팀의 기록 원본은 Drive여야 한다**는 논지는 유지하되 "아무것도 남지 않는다"는 뉘앙스는 제거합니다.
- Lines ~78-110 (`unsynced`/`stale` 대응): `local` 행에도 동일하게 적용된다는 점을 명시. 특히 line ~105의 "`pnpm drive:publish`는 조용히 아무 일도 하지 않습니다" 는 해시 없는 legacy 행 이야기이므로 **그대로 유지** — 다만 그 함정이 `local` 행에는 없다(모든 `local` 행은 처음부터 해시를 가짐)는 한 줄을 추가합니다.

- [ ] **Step 7: `docs/ko/review.md` and `docs/ko/setup/README.md`**

- `review.md:87` — `발행 ⬆` 설명에서 "팀 공유 드라이브에 문서로 올리는 기능" → 저장 모드에 따라 팀 드라이브 **또는** 로컬 폴더(`output/publish/local/`). "채널 게시가 아닙니다" 문장은 유지.
- `setup/README.md:17-20` — the command list gains the new forms:

```
pnpm drive:publish                       # 저장 모드의 기본 대상 (local 모드→local, cloud 모드→google)
pnpm drive:publish --target google       # 구글만
pnpm drive:publish --target lark         # Lark만
pnpm drive:publish --target both         # google,lark 별칭
pnpm drive:publish --target local        # 로컬 파일 (output/publish/local/)
pnpm drive:publish --target google,local # 쉼표로 여러 대상
```

- [ ] **Step 8: `CHANGELOG.md`**

Under `[Unreleased]`, add (Keep a Changelog style, matching the existing entries' voice):

```markdown
### Added
- `local` publish target: `pnpm drive:publish` now writes the review/approved markdown documents to
  `output/publish/local/{review,approved}/` instead of skipping publication in
  `HERALD_STORAGE_MODE=local`. `--target` accepts a comma-separated list (`google,local`); `both`
  remains an alias for `google,lark`. The dashboard publishes in local mode too, and picks its
  target options from the new `GET /api/config`.

### Changed
- `pnpm status` warns about unsynced/stale work in `local` mode exactly as in `cloud` mode. The
  previous `(local mode — publishing disabled)` line hid a real backlog now that local publishing
  exists.
- `skipIfLocal()` now gates four commands, not five: `drive:publish` left the list.

### Fixed
- Re-publishing after a re-approval no longer risks a duplicate document. `publishFileName` embeds
  `approvedAt`'s date, so re-approving on a later day changes the filename; `LocalFileUploader.update`
  moves the file rather than writing a second copy, mirroring the Drive PATCH that preserves a file id.
```

- [ ] **Step 9: Verify no stale claim survives**

Run:

```bash
grep -rn "publishing disabled\|다섯 개\|five CLIs" docs/ .env.example src/ | grep -v "docs/superpowers/"
```

Expected: no hits. `docs/superpowers/` is excluded because specs and plans are a frozen development archive, deliberately left stale — the precedent set in PR #34.

Do **not** grep for `local mode — skipped`: that string is `localSkipMessage()` in `src/storage/mode.ts:43` and remains correct for the four commands that still skip. Instead confirm the count directly:

```bash
grep -rln "skipIfLocal" src/cli/ | grep -v skipIfLocal.ts | wc -l
```

Expected: `4`.

- [ ] **Step 10: Commit**

```bash
git add docs/ko .env.example CHANGELOG.md
git commit -m "docs: local mode publishes to disk, it does not skip publishing"
```

---

### Task 9: Full verification and PR

**Files:** none modified.

- [ ] **Step 1: Run everything**

Run:

```bash
pnpm test && pnpm typecheck && pnpm typecheck:web && pnpm build:web
```

Expected: all four succeed. Record the test count.

- [ ] **Step 2: Confirm the two modes behave differently and correctly**

```bash
HERALD_STORAGE_MODE=local pnpm doctor
HERALD_STORAGE_MODE=local pnpm status
HERALD_STORAGE_MODE=local pnpm drive:publish
```

Expected: `doctor` still downgrades cloud credential checks to `warn` and exits 0. `status` shows the sync line with no local-mode label. `drive:publish` reports `0 new + 0 updated` on a second run (idempotent) and names the local directory.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/local-file-publishing
gh pr create --title "feat: local mode publishes to disk instead of skipping" --body "$(cat <<'EOF'
Closes the gap where `HERALD_STORAGE_MODE=local` skipped `drive:publish` entirely, so the
`<date>-<slug>-<id>.md` review document never existed anywhere and a user without a Google
account had no way to export a readable result.

This corrects a requirement that was narrowed from "save locally" to "skip publishing" at spec
time without being flagged — see the spec for the full history.

- `LocalFileUploader implements DriveUploader`, so the renderers, `PublishTranslations`, the sync
  ledger, `isStale`, failure isolation and the dashboard counters are all reused unchanged.
- `update()` moves rather than overwrites: `publishFileName` embeds `approvedAt`'s date, so
  re-approving on a later day changes the filename and a plain overwrite would strand the old
  file as an indistinguishable duplicate.
- Uploader construction, previously duplicated between `publish.ts` and `serve.ts`, is now one
  `src/cli/uploaders.ts`.
- `pnpm status` no longer suppresses its warning in local mode.

Spec: `docs/superpowers/specs/2026-07-21-local-file-publishing-design.md`
Plan: `docs/superpowers/plans/2026-07-21-local-file-publishing.md`
EOF
)"
```

- [ ] **Step 4: Wait for CI**

Run: `gh pr checks --watch`
Expected: the required `test` check passes.
