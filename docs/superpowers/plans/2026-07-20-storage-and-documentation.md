# Artifact Storage + Documentation Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix where pipeline artifacts are stored — one path source, an explicit storage mode, a real sync ledger, and archive/clean retention — then document the whole system in Korean for external and internal readers.

**Architecture:** All artifact paths collapse into `src/paths.ts`, anchored to the repo root instead of the process CWD. An explicit `HERALD_STORAGE_MODE` splits `local` (no cloud, archive is the safety net) from `cloud` (Drive is the record of truth). `output/publish/state.json` is promoted from a flat key set to a sync ledger recording target, remote id, URL, filename, content hash and timestamp, migrating the legacy format on read. Real steering config leaves git; `*.example.*` skeletons stay.

**Tech Stack:** TypeScript ESM (`moduleResolution: bundler`, no `.js` extensions), `zod` as the only runtime dependency, `vitest`, `tsx` for CLIs, pnpm.

## Global Constraints

- **Runtime dependencies stay `zod`-only.** No new runtime packages. Node built-ins (`node:crypto`, `node:fs/promises`, `node:path`, `node:url`) are fine.
- **All code, identifiers, comments and in-code docs in English.** The four documents under `docs/ko/` are written in Korean; everything else — including `docs/README.md` and this plan's commit messages — is English.
- **Hexagonal layering:** `domain/` (pure) → `ports/` (interfaces) → `adapters/` (I/O) → `app/` (use-cases) → `cli/` (entrypoints). Pure logic that needs tests goes in `domain/` or a `src/<topic>/` module (following the existing `src/status/`, `src/doctor/` pattern), never in a CLI file.
- **ESM imports carry no file extension** — `import { x } from "../config"`, matching every existing file.
- **`main` is branch-protected.** Work happens on `docs/storage-and-documentation`; integration is push + PR + CI, never a local merge.
- **Every task ends with a commit.** Conventional Commits style (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- **`CHANGELOG.md` is hand-curated** — add entries under `[Unreleased]`, no tooling.
- Test command: `pnpm test` (vitest). Type check: `pnpm typecheck`.

---

## File Structure

**New source files**

| File | Responsibility |
|---|---|
| `src/paths.ts` | Single source of truth for every artifact and config path, anchored to repo root |
| `src/storage/mode.ts` | Pure: parse/validate the storage mode, build the local-skip message |
| `src/cli/skipIfLocal.ts` | CLI helper: exit 0 with a message when a cloud command runs in `local` mode |
| `src/domain/publish/syncLedger.ts` | Pure: `SyncEntry` shape, key derivation, content hashing, legacy migration, staleness |
| `src/storage/retention.ts` | Pure: which archive folders have expired, which files are stranded temp files |
| `src/shared/store/archive.ts` | Move a file into the dated archive folder |
| `src/cli/config-init.ts` | `pnpm config:init` — copy `*.example.*` steering files into place when missing |
| `src/cli/archive.ts` | `pnpm archive` — sweep worksheets into today's archive folder |
| `src/cli/clean.ts` | `pnpm clean` — delete expired archives and stranded temp files |
| `src/status/sync.ts` | Pure: published / unsynced / stale counts from ledger + translations |

**Modified source files**

| File | Change |
|---|---|
| `src/config.ts` | Add `loadStorageMode()` |
| `src/ports/PublishStore.ts` | `record(key)` → `record(entry)`, add `listEntries()` |
| `src/adapters/store/JsonPublishStore.ts` | Ledger schema + legacy migration on read |
| `src/domain/publish/publishModels.ts` | `UploadResult` gains optional `url` |
| `src/adapters/drive/GoogleDriveUploader.ts` | Request and return `webViewLink` |
| `src/app/PublishTranslations.ts` | Build and record full ledger entries |
| 12 CLI files | Replace 36 path literals with `paths.*` |
| `src/cli/{publish,drive-init,sheet-init,targets-list,history-record}.ts` | `skipIfLocal(...)` guard |
| `src/cli/{translate-prepare,convert-prepare,format}.ts` | Atomic pending write + archive-before-overwrite |
| `src/cli/{translate-save,format-save}.ts` | Already-saved fallback |
| `src/cli/doctor.ts` | Report active storage mode; check steering files exist |
| `src/cli/status.ts` | Print the sync summary line |

**Documentation files**

`docs/README.md`, `docs/ko/{capabilities,quickstart,team-runbook,artifacts}.md`, `docs/en/.gitkeep`, `README.md` (reduced), `.env.example`, `.gitignore`, `CHANGELOG.md`.

---

### Task 1: Centralise artifact paths

Removes all 36 `"output/..."` literals and the CWD dependence that lets a second `output/` tree appear when a command runs from a subdirectory.

**Files:**
- Create: `src/paths.ts`
- Create: `tests/paths.test.ts`
- Modify: `src/cli/collect.ts:12`, `src/cli/collect-lark.ts:15`, `src/cli/reconcile.ts:10`, `src/cli/status.ts:12-20`, `src/cli/serve.ts:24-28`, `src/cli/publish.ts:31`, `src/cli/translate-prepare.ts:16-47`, `src/cli/translate-save.ts:17-25`, `src/cli/convert-prepare.ts:34-54`, `src/cli/convert-save.ts:21-40`, `src/cli/format.ts:31-43`, `src/cli/format-save.ts:20-27`, `src/cli/glossary.ts:6`

**Interfaces:**
- Consumes: nothing.
- Produces: `REPO_ROOT`, `OUTPUT_DIR`, and the `paths` object with these exact keys — `xDir`, `xItems`, `larkDir`, `larkItems`, `translationsDir`, `translationsPending`, `translationsWorksheets`, `variantsDir`, `variantsPending`, `variantsWorksheets`, `formattedDir`, `formattedPending`, `formattedWorksheets`, `publishDir`, `archiveDir`, `translationConfigDir`, `conversionConfigDir`. Every later task imports from here.

- [ ] **Step 1: Write the failing test**

Create `tests/paths.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { OUTPUT_DIR, REPO_ROOT, paths } from "../src/paths";

const original = process.cwd();
afterEach(() => process.chdir(original));

describe("paths", () => {
  it("anchors to the repo root, not the process cwd", () => {
    const before = OUTPUT_DIR;
    process.chdir(tmpdir());
    expect(OUTPUT_DIR).toBe(before);
    expect(OUTPUT_DIR).toBe(join(REPO_ROOT, "output"));
  });

  it("exposes absolute paths for every store", () => {
    for (const value of Object.values(paths)) {
      expect(isAbsolute(value)).toBe(true);
    }
  });

  it("places stores under their stage directory", () => {
    expect(paths.xItems).toBe(join(OUTPUT_DIR, "x", "items.json"));
    expect(paths.translationsPending).toBe(join(OUTPUT_DIR, "translations", "pending.json"));
    expect(paths.formattedWorksheets).toBe(join(OUTPUT_DIR, "formatted", "worksheets"));
    expect(paths.archiveDir).toBe(join(OUTPUT_DIR, "archive"));
  });

  it("points the steering config dirs at the repo root", () => {
    expect(paths.translationConfigDir).toBe(join(REPO_ROOT, "translation"));
    expect(paths.conversionConfigDir).toBe(join(REPO_ROOT, "conversion"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/paths.test.ts`
Expected: FAIL — `Failed to resolve import "../src/paths"`.

- [ ] **Step 3: Create `src/paths.ts`**

```ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo root, resolved from this module's own location. Deliberately NOT process.cwd():
 * relative paths made every command depend on being run from the repo root, and running one
 * from a subdirectory silently created a second output/ tree instead of failing.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Root of all pipeline artifacts. Fixed by design — see the storage design spec. */
export const OUTPUT_DIR = join(REPO_ROOT, "output");

export const paths = {
  xDir: join(OUTPUT_DIR, "x"),
  xItems: join(OUTPUT_DIR, "x", "items.json"),
  larkDir: join(OUTPUT_DIR, "lark"),
  larkItems: join(OUTPUT_DIR, "lark", "items.json"),
  translationsDir: join(OUTPUT_DIR, "translations"),
  translationsPending: join(OUTPUT_DIR, "translations", "pending.json"),
  translationsWorksheets: join(OUTPUT_DIR, "translations", "worksheets"),
  variantsDir: join(OUTPUT_DIR, "variants"),
  variantsPending: join(OUTPUT_DIR, "variants", "pending.json"),
  variantsWorksheets: join(OUTPUT_DIR, "variants", "worksheets"),
  formattedDir: join(OUTPUT_DIR, "formatted"),
  formattedPending: join(OUTPUT_DIR, "formatted", "pending.json"),
  formattedWorksheets: join(OUTPUT_DIR, "formatted", "worksheets"),
  publishDir: join(OUTPUT_DIR, "publish"),
  archiveDir: join(OUTPUT_DIR, "archive"),
  translationConfigDir: join(REPO_ROOT, "translation"),
  conversionConfigDir: join(REPO_ROOT, "conversion"),
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/paths.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace every literal in the CLI files**

Import `paths` in each file and substitute. The full mapping — every occurrence must be replaced, `grep -rn '"output/' src/` must return nothing when done:

| File:line | Was | Becomes |
|---|---|---|
| `collect.ts:12` | `new LocalJsonStore("output/x")` | `new LocalJsonStore(paths.xDir)` |
| `collect-lark.ts:15` | `new LarkLocalStore("output/lark")` | `new LarkLocalStore(paths.larkDir)` |
| `reconcile.ts:10` | `new LocalJsonStore("output/x")` | `new LocalJsonStore(paths.xDir)` |
| `status.ts:12` | `new XContentSource("output/x/items.json")` | `new XContentSource(paths.xItems)` |
| `status.ts:13` | `new LarkContentSource("output/lark/items.json")` | `new LarkContentSource(paths.larkItems)` |
| `status.ts:17` | `new JsonTranslationStore("output/translations")` | `new JsonTranslationStore(paths.translationsDir)` |
| `status.ts:18` | `new JsonConversionStore("output/variants")` | `new JsonConversionStore(paths.variantsDir)` |
| `status.ts:19` | `new JsonFormattingStore("output/formatted")` | `new JsonFormattingStore(paths.formattedDir)` |
| `status.ts:20` | `new JsonPublishStore("output/publish")` | `new JsonPublishStore(paths.publishDir)` |
| `serve.ts:24` | `new JsonTranslationStore("output/translations")` | `new JsonTranslationStore(paths.translationsDir)` |
| `serve.ts:25` | `new JsonPublishStore("output/publish")` | `new JsonPublishStore(paths.publishDir)` |
| `serve.ts:26` | `new JsonFewShotStore("translation")` | `new JsonFewShotStore(paths.translationConfigDir)` |
| `serve.ts:27` | `new JsonFormattingStore("output/formatted")` | `new JsonFormattingStore(paths.formattedDir)` |
| `serve.ts:28` | `new JsonConversionStore("output/variants")` | `new JsonConversionStore(paths.variantsDir)` |
| `publish.ts:31` | `new JsonTranslationStore("output/translations")`, `new JsonPublishStore("output/publish")` | `new JsonTranslationStore(paths.translationsDir)`, `new JsonPublishStore(paths.publishDir)` |
| `translate-prepare.ts:16` | `new XContentSource("output/x/items.json")` | `new XContentSource(paths.xItems)` |
| `translate-prepare.ts:17` | `new LarkContentSource("output/lark/items.json")` | `new LarkContentSource(paths.larkItems)` |
| `translate-prepare.ts:34` | `new JsonGlossaryStore("translation")` | `new JsonGlossaryStore(paths.translationConfigDir)` |
| `translate-prepare.ts:35` | `new JsonFewShotStore("translation")` | `new JsonFewShotStore(paths.translationConfigDir)` |
| `translate-prepare.ts:36` | `new FileTranslationConfig("translation")` | `new FileTranslationConfig(paths.translationConfigDir)` |
| `translate-prepare.ts:37` | `new JsonTranslationStore("output/translations")` | `new JsonTranslationStore(paths.translationsDir)` |
| `translate-prepare.ts:42` | `mkdir("output/translations/worksheets", …)` | `mkdir(paths.translationsWorksheets, …)` |
| `translate-prepare.ts:44` | `join("output/translations/worksheets", …)` | `join(paths.translationsWorksheets, …)` |
| `translate-prepare.ts:47` | `join("output/translations", "pending.json")` | `paths.translationsPending` |
| `translate-save.ts:17` | `readJsonFile(…"output/translations/pending.json"…)` | `readJsonFile(…paths.translationsPending…)` |
| `translate-save.ts:25` | `new JsonTranslationStore("output/translations")`, `new JsonFewShotStore("translation")` | `new JsonTranslationStore(paths.translationsDir)`, `new JsonFewShotStore(paths.translationConfigDir)` |
| `convert-prepare.ts:34-36` | `new JsonTypedFewShotStore("conversion", …)` ×3 | `new JsonTypedFewShotStore(paths.conversionConfigDir, …)` ×3 |
| `convert-prepare.ts:40` | `new JsonTranslationStore("output/translations")` | `new JsonTranslationStore(paths.translationsDir)` |
| `convert-prepare.ts:41` | `new JsonGlossaryStore("translation")` | `new JsonGlossaryStore(paths.translationConfigDir)` |
| `convert-prepare.ts:42` | `new FileTranslationConfig("translation")` | `new FileTranslationConfig(paths.translationConfigDir)` |
| `convert-prepare.ts:43` | `new FileConversionConfig("conversion")` | `new FileConversionConfig(paths.conversionConfigDir)` |
| `convert-prepare.ts:45` | `new JsonConversionStore("output/variants")` | `new JsonConversionStore(paths.variantsDir)` |
| `convert-prepare.ts:50` | `mkdir("output/variants/worksheets", …)` | `mkdir(paths.variantsWorksheets, …)` |
| `convert-prepare.ts:52` | `join("output/variants/worksheets", …)` | `join(paths.variantsWorksheets, …)` |
| `convert-prepare.ts:54` | `join("output/variants", "pending.json")` | `paths.variantsPending` |
| `convert-save.ts:21` | `new JsonConversionStore("output/variants")` | `new JsonConversionStore(paths.variantsDir)` |
| `convert-save.ts:23` | `readJsonFile(…"output/variants/pending.json"…)` | `readJsonFile(…paths.variantsPending…)` |
| `convert-save.ts:38-40` | `new JsonTypedFewShotStore("conversion", …)` ×3 | `new JsonTypedFewShotStore(paths.conversionConfigDir, …)` ×3 |
| `format.ts:31` | `new JsonConversionStore("output/variants")` | `new JsonConversionStore(paths.variantsDir)` |
| `format.ts:35` | `mkdir("output/formatted/worksheets", …)` | `mkdir(paths.formattedWorksheets, …)` |
| `format.ts:37` | `join("output/formatted/worksheets", …)` | `join(paths.formattedWorksheets, …)` |
| `format.ts:39` | `join("output/formatted", "pending.json")` | `paths.formattedPending` |
| `format.ts:43` | `new JsonFormattingStore("output/formatted")` | `new JsonFormattingStore(paths.formattedDir)` |
| `format-save.ts:20` | `readJsonFile(…"output/formatted/pending.json"…)` | `readJsonFile(…paths.formattedPending…)` |
| `format-save.ts:27` | `new JsonFormattingStore("output/formatted")` | `new JsonFormattingStore(paths.formattedDir)` |
| `glossary.ts:6` | `new JsonGlossaryStore("translation")` | `new JsonGlossaryStore(paths.translationConfigDir)` |

Add `import { paths } from "../paths";` to each of the 13 files.

- [ ] **Step 6: Verify no literals remain and everything still passes**

Run: `grep -rn '"output/\|"translation"\|"conversion"' src/`
Expected: no output.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean; full suite passes (252 tests + the 4 new = 256, 6 skipped).

- [ ] **Step 7: Commit**

```bash
git add src/paths.ts tests/paths.test.ts src/cli
git commit -m "refactor: centralise artifact paths in src/paths.ts, anchored to repo root"
```

---

### Task 2: Explicit storage mode

**Files:**
- Create: `src/storage/mode.ts`
- Create: `src/cli/skipIfLocal.ts`
- Create: `tests/storage/mode.test.ts`
- Modify: `src/config.ts` (append), `src/cli/publish.ts`, `src/cli/drive-init.ts`, `src/cli/sheet-init.ts`, `src/cli/targets-list.ts`, `src/cli/history-record.ts`, `src/cli/doctor.ts`, `.env.example`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type StorageMode = "local" | "cloud"`; `parseStorageMode(raw: string | undefined): StorageMode`; `localSkipMessage(command: string): string`; `loadStorageMode(): StorageMode` (from `src/config`); `skipIfLocal(command: string): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/mode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseStorageMode, localSkipMessage } from "../../src/storage/mode";

describe("parseStorageMode", () => {
  it("accepts the two valid modes", () => {
    expect(parseStorageMode("local")).toBe("local");
    expect(parseStorageMode("cloud")).toBe("cloud");
  });

  it("trims surrounding whitespace", () => {
    expect(parseStorageMode("  cloud  ")).toBe("cloud");
  });

  it("never guesses when unset — it throws and names both valid values", () => {
    expect(() => parseStorageMode(undefined)).toThrow(/HERALD_STORAGE_MODE/);
    expect(() => parseStorageMode(undefined)).toThrow(/local/);
    expect(() => parseStorageMode(undefined)).toThrow(/cloud/);
    expect(() => parseStorageMode("")).toThrow(/HERALD_STORAGE_MODE/);
  });

  it("rejects an unknown value and echoes it back", () => {
    expect(() => parseStorageMode("gcs")).toThrow(/gcs/);
  });
});

describe("localSkipMessage", () => {
  it("names the command and how to enable it", () => {
    const msg = localSkipMessage("drive:publish");
    expect(msg).toContain("drive:publish");
    expect(msg).toContain("local mode");
    expect(msg).toContain("HERALD_STORAGE_MODE=cloud");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/storage/mode.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/storage/mode"`.

- [ ] **Step 3: Create `src/storage/mode.ts`**

```ts
/** Where approved artifacts are preserved: nowhere but locally, or on Drive. */
export type StorageMode = "local" | "cloud";

const VALID: readonly StorageMode[] = ["local", "cloud"];

/**
 * Never inferred from which credentials happen to be present: silently choosing "local" while
 * the operator believes work is backed up to Drive is the one failure this must not allow.
 */
export function parseStorageMode(raw: string | undefined): StorageMode {
  const value = raw?.trim();
  if (!value) {
    throw new Error(
      'Missing required environment variable: HERALD_STORAGE_MODE (expected "local" or "cloud"). Run pnpm doctor.',
    );
  }
  if (!VALID.includes(value as StorageMode)) {
    throw new Error(`Invalid HERALD_STORAGE_MODE: ${value} (expected "local" or "cloud"). Run pnpm doctor.`);
  }
  return value as StorageMode;
}

export function localSkipMessage(command: string): string {
  return `${command}: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/storage/mode.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the loader and the CLI guard**

Append to `src/config.ts`:

```ts
import { parseStorageMode, type StorageMode } from "./storage/mode";

export type { StorageMode };

export function loadStorageMode(): StorageMode {
  return parseStorageMode(process.env.HERALD_STORAGE_MODE);
}
```

(Put the `import` with the other imports at the top of the file — `src/config.ts` currently has none, so add it as line 1.)

Create `src/cli/skipIfLocal.ts`:

```ts
import { loadStorageMode } from "../config";
import { localSkipMessage } from "../storage/mode";

/**
 * Cloud commands are a no-op in local mode. Exits 0, not non-zero: not publishing in local mode
 * is correct behaviour, and a failing exit code would break any wrapper script.
 */
export function skipIfLocal(command: string): void {
  if (loadStorageMode() === "local") {
    console.log(localSkipMessage(command));
    process.exit(0);
  }
}
```

- [ ] **Step 6: Guard the five cloud commands**

In each file, add `import { skipIfLocal } from "./skipIfLocal";` and call it immediately after the `import "./registerErrorHandler";` line and any `argValue` reads, before any config loading or network work:

| File | Call |
|---|---|
| `src/cli/publish.ts` | `skipIfLocal("drive:publish");` |
| `src/cli/drive-init.ts` | `skipIfLocal("drive:init");` |
| `src/cli/sheet-init.ts` | `skipIfLocal("sheet:init");` |
| `src/cli/targets-list.ts` | `skipIfLocal("targets:list");` |
| `src/cli/history-record.ts` | `skipIfLocal("history:record");` |

- [ ] **Step 7: Report the mode in `doctor`**

In `src/cli/doctor.ts`, add `loadStorageMode` to the existing import from `"../config"`, and insert this as the **first** entry pushed to `results` (before the twitterapi.io check):

```ts
results.push(configCheck("Storage mode", () => loadStorageMode(), `mode: ${process.env.HERALD_STORAGE_MODE?.trim() ?? "(unset)"}`));
```

- [ ] **Step 8: Ship the mode in `.env.example`**

Add to the top of `.env.example`, uncommented:

```bash
# Where approved artifacts are preserved.
#   local — no cloud; everything stays under output/ and is archived automatically
#   cloud — Google/Lark Drive is the record of truth; drive:publish and the Sheet commands run
HERALD_STORAGE_MODE=local
```

- [ ] **Step 9: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests pass.

Run: `HERALD_STORAGE_MODE=local pnpm drive:publish`
Expected: prints `drive:publish: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)`; `echo $?` prints `0`.

Run: `HERALD_STORAGE_MODE=bogus pnpm status`
Expected: `pnpm status` still works — it is not a cloud command and must not require the mode.

- [ ] **Step 10: Commit**

```bash
git add src/storage src/cli/skipIfLocal.ts src/config.ts src/cli tests/storage .env.example
git commit -m "feat: explicit HERALD_STORAGE_MODE gating the cloud commands"
```

---

### Task 3: Sync ledger

Promotes `output/publish/state.json` from `{published: string[]}` to a ledger recording **which cloud, which remote file, which URL, what content, and when** — so re-sync, staleness detection and link recovery become possible.

**Files:**
- Create: `src/domain/publish/syncLedger.ts`
- Create: `tests/domain/publish/syncLedger.test.ts`
- Modify: `src/ports/PublishStore.ts`, `src/adapters/store/JsonPublishStore.ts`, `tests/adapters/store/jsonPublishStore.test.ts`, `src/domain/publish/publishModels.ts`, `src/adapters/drive/GoogleDriveUploader.ts`, `src/app/PublishTranslations.ts`, `tests/app/` publish test

**Interfaces:**
- Consumes: `paths.publishDir` (Task 1).
- Produces:
  - `interface SyncEntry { itemId: string; stage: "translation"; status: string; target: string; fileName?: string; remoteId?: string; url?: string; contentHash?: string; uploadedAt?: string }`
  - `entryKey(e: Pick<SyncEntry, "itemId" | "status" | "target">): string` → `"<itemId>:<status>:<target>"`
  - `contentHash(content: string): string` → `"sha256:<hex>"`
  - `migrateLegacyKeys(keys: string[]): SyncEntry[]`
  - `isStale(entry: SyncEntry, currentHash: string): boolean`
  - `PublishStore.listEntries(): Promise<SyncEntry[]>`, `PublishStore.record(entry: SyncEntry): Promise<void>`, `PublishStore.listPublished(): Promise<Set<string>>`
  - `UploadResult.url?: string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/publish/syncLedger.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { entryKey, contentHash, migrateLegacyKeys, isStale, type SyncEntry } from "../../../src/domain/publish/syncLedger";

describe("entryKey", () => {
  it("joins itemId, status and target", () => {
    expect(entryKey({ itemId: "x:1934", status: "approved", target: "google" })).toBe("x:1934:approved:google");
  });
});

describe("contentHash", () => {
  it("is stable and prefixed", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when the content changes", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("migrateLegacyKeys", () => {
  it("splits from the right, because itemId itself contains a colon", () => {
    const [entry] = migrateLegacyKeys(["x:1934567:approved:google"]);
    expect(entry.itemId).toBe("x:1934567");
    expect(entry.status).toBe("approved");
    expect(entry.target).toBe("google");
    expect(entry.stage).toBe("translation");
  });

  it("leaves the unknowable fields undefined rather than inventing them", () => {
    const [entry] = migrateLegacyKeys(["lark:om_abc:translated:lark"]);
    expect(entry.remoteId).toBeUndefined();
    expect(entry.contentHash).toBeUndefined();
    expect(entry.uploadedAt).toBeUndefined();
  });

  it("skips malformed keys instead of throwing", () => {
    expect(migrateLegacyKeys(["nonsense"])).toEqual([]);
  });
});

describe("isStale", () => {
  const base: SyncEntry = { itemId: "x:1", stage: "translation", status: "approved", target: "google" };

  it("is true when the content changed since upload", () => {
    expect(isStale({ ...base, contentHash: contentHash("old") }, contentHash("new"))).toBe(true);
  });

  it("is false when the content is unchanged", () => {
    expect(isStale({ ...base, contentHash: contentHash("same") }, contentHash("same"))).toBe(false);
  });

  it("is false for a migrated entry — an unknown hash is not evidence of staleness", () => {
    expect(isStale(base, contentHash("anything"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/publish/syncLedger.test.ts`
Expected: FAIL — cannot resolve `syncLedger`.

- [ ] **Step 3: Create `src/domain/publish/syncLedger.ts`**

```ts
import { createHash } from "node:crypto";

/**
 * One row per (itemId, status, target). Fields after `target` are optional because entries
 * migrated from the legacy `{published: string[]}` format genuinely do not know them —
 * recording a placeholder would make a migrated row indistinguishable from a real upload.
 */
export interface SyncEntry {
  itemId: string;
  stage: "translation";
  status: string;
  target: string;
  fileName?: string;
  remoteId?: string;
  url?: string;
  contentHash?: string;
  uploadedAt?: string;
}

export function entryKey(e: Pick<SyncEntry, "itemId" | "status" | "target">): string {
  return `${e.itemId}:${e.status}:${e.target}`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Legacy keys are `<itemId>:<status>:<target>`, and itemId contains a colon of its own
 * ("x:1934"), so split from the right and treat everything left of the last two parts as the id.
 */
export function migrateLegacyKeys(keys: string[]): SyncEntry[] {
  const entries: SyncEntry[] = [];
  for (const key of keys) {
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const target = parts[parts.length - 1];
    const status = parts[parts.length - 2];
    const itemId = parts.slice(0, -2).join(":");
    if (!itemId || !status || !target) continue;
    entries.push({ itemId, stage: "translation", status, target });
  }
  return entries;
}

/** A migrated entry has no hash — unknown is not the same as changed, so it is not stale. */
export function isStale(entry: SyncEntry, currentHash: string): boolean {
  return entry.contentHash !== undefined && entry.contentHash !== currentHash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/publish/syncLedger.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing store test**

Append to `tests/adapters/store/jsonPublishStore.test.ts` (keep the existing tests; they may need their `record("key")` calls updated to the new entry signature):

```ts
it("migrates the legacy published-key format on read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ published: ["x:1934:approved:google", "x:1934:approved:lark"] }),
    "utf8",
  );

  const store = new JsonPublishStore(dir);
  const entries = await store.listEntries();

  expect(entries).toHaveLength(2);
  expect(entries.map((e) => e.target).sort()).toEqual(["google", "lark"]);
  expect(entries[0].itemId).toBe("x:1934");
  expect(await store.listPublished()).toEqual(new Set(["x:1934:approved:google", "x:1934:approved:lark"]));
});

it("upserts by (itemId, status, target) so a re-upload replaces the old row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const store = new JsonPublishStore(dir);

  await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "a", contentHash: "sha256:aa", uploadedAt: "2026-07-20T00:00:00.000Z" });
  await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "b", contentHash: "sha256:bb", uploadedAt: "2026-07-21T00:00:00.000Z" });
  await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "lark", remoteId: "c" });

  const entries = await store.listEntries();
  expect(entries).toHaveLength(2);
  expect(entries.find((e) => e.target === "google")?.remoteId).toBe("b");
  expect(entries.find((e) => e.target === "lark")?.remoteId).toBe("c");
});
```

Add whatever imports the file is missing (`mkdtemp`, `mkdir`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`).

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run tests/adapters/store/jsonPublishStore.test.ts`
Expected: FAIL — `store.listEntries is not a function`.

- [ ] **Step 7: Update the port and the store**

Replace `src/ports/PublishStore.ts`:

```ts
import type { SyncEntry } from "../domain/publish/syncLedger";

export interface PublishStore {
  /** Every recorded upload, one row per (itemId, status, target). */
  listEntries(): Promise<SyncEntry[]>;
  /** Set of "<itemId>:<status>:<target>" keys already uploaded — the idempotency check. */
  listPublished(): Promise<Set<string>>;
  /** Upsert one entry by its key. */
  record(entry: SyncEntry): Promise<void>;
}
```

Replace `src/adapters/store/JsonPublishStore.ts`:

```ts
import { join } from "node:path";
import type { PublishStore } from "../../ports/PublishStore";
import { entryKey, migrateLegacyKeys, type SyncEntry } from "../../domain/publish/syncLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  entries?: SyncEntry[];
  /** Legacy format, still read so no manual migration is needed. */
  published?: string[];
}

export class JsonPublishStore implements PublishStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "state.json");
  }

  async listEntries(): Promise<SyncEntry[]> {
    const state = await readJsonFile<StateFile>(this.path, {});
    if (state.entries) return state.entries;
    return migrateLegacyKeys(state.published ?? []);
  }

  async listPublished(): Promise<Set<string>> {
    return new Set((await this.listEntries()).map(entryKey));
  }

  async record(entry: SyncEntry): Promise<void> {
    const entries = await this.listEntries();
    const key = entryKey(entry);
    const next = entries.filter((e) => entryKey(e) !== key);
    next.push(entry);
    await writeJsonFileAtomic(this.dir, this.path, { entries: next } satisfies StateFile);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run tests/adapters/store/jsonPublishStore.test.ts`
Expected: PASS.

- [ ] **Step 9: Capture the URL from Google, then record full entries**

In `src/domain/publish/publishModels.ts`, extend `UploadResult`:

```ts
export interface UploadResult {
  id: string;
  name: string;
  /** Viewer link, when the drive returns one (Google does; Lark's upload response does not). */
  url?: string;
}
```

In `src/adapters/drive/GoogleDriveUploader.ts`, request the link — change the constant and the return:

```ts
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink";
```

```ts
    const data = (await res.json()) as { id?: string; name?: string; webViewLink?: string };
    if (!data.id) throw new Error("Google Drive upload response missing id");
    return { id: data.id, name: data.name ?? req.name, url: data.webViewLink };
```

In `src/app/PublishTranslations.ts`, record the entry instead of a bare key. Add the imports and a clock, and replace the success branch:

```ts
import { contentHash, entryKey, type SyncEntry } from "../domain/publish/syncLedger";
```

```ts
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly uploaders: DriveUploader[],
    private readonly publishStore: PublishStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
```

```ts
      for (const uploader of this.uploaders) {
        const key = entryKey({ itemId: t.itemId, status: t.status, target: uploader.name });
        if (published.has(key)) continue;
        try {
          const result = await uploader.upload({ name, content, folder });
          const entry: SyncEntry = {
            itemId: t.itemId,
            stage: "translation",
            status: t.status,
            target: uploader.name,
            fileName: result.name,
            remoteId: result.id,
            url: result.url,
            contentHash: contentHash(content),
            uploadedAt: this.now().toISOString(),
          };
          await this.publishStore.record(entry);
          uploaded += 1;
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch (err) {
          failed += 1;
          failures.push({ key, error: err instanceof Error ? err.message : String(err) });
        }
      }
```

- [ ] **Step 10: Add a use-case test for the recorded entry**

Add to the existing `PublishTranslations` test file in `tests/app/` (find it with `ls tests/app/`):

```ts
it("records what was uploaded, where, and with which content", async () => {
  const recorded: SyncEntry[] = [];
  const store: PublishStore = {
    listEntries: async () => recorded,
    listPublished: async () => new Set(recorded.map(entryKey)),
    record: async (e) => { recorded.push(e); },
  };
  const uploader: DriveUploader = {
    name: "google",
    upload: async () => ({ id: "file-1", name: "doc.md", url: "https://drive.example/file-1" }),
  };

  await new PublishTranslations(translationStoreWithOneApproved, [uploader], store, () => new Date("2026-07-20T09:00:00.000Z")).run();

  expect(recorded).toHaveLength(1);
  expect(recorded[0].target).toBe("google");
  expect(recorded[0].remoteId).toBe("file-1");
  expect(recorded[0].url).toBe("https://drive.example/file-1");
  expect(recorded[0].uploadedAt).toBe("2026-07-20T09:00:00.000Z");
  expect(recorded[0].contentHash).toMatch(/^sha256:/);
});
```

Reuse the file's existing translation-store fixture in place of `translationStoreWithOneApproved`, and import `SyncEntry`, `entryKey` from `../../src/domain/publish/syncLedger`.

- [ ] **Step 11: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests pass. Fix any other `record(` call sites the type checker flags (the dashboard's publish route in `src/adapters/web/` goes through `PublishTranslations`, so it should need no change).

- [ ] **Step 12: Commit**

```bash
git add src/domain/publish src/ports/PublishStore.ts src/adapters/store/JsonPublishStore.ts src/adapters/drive/GoogleDriveUploader.ts src/app/PublishTranslations.ts tests
git commit -m "feat: sync ledger recording target, remote id, url and content hash"
```

---

### Task 4: Report sync state in `pnpm status`

**Files:**
- Create: `src/status/sync.ts`
- Create: `tests/status/sync.test.ts`
- Modify: `src/cli/status.ts`

**Interfaces:**
- Consumes: `SyncEntry`, `contentHash`, `entryKey`, `isStale` (Task 3); `paths` (Task 1).
- Produces: `syncSummary(input: { translations: Translation[]; entries: SyncEntry[]; render: (t: Translation) => string }): { published: number; unsynced: number; stale: number }` and `formatSyncSummary(s: {...}): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/status/sync.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { syncSummary, formatSyncSummary } from "../../src/status/sync";
import { contentHash, type SyncEntry } from "../../src/domain/publish/syncLedger";

const render = (t: { itemId: string; text: string }) => t.text;
const t = (itemId: string, status: string, text: string) => ({ itemId, status, text });

describe("syncSummary", () => {
  it("counts an approved translation with no ledger row as unsynced", () => {
    const s = syncSummary({ translations: [t("x:1", "approved", "hi")], entries: [], render });
    expect(s).toEqual({ published: 0, unsynced: 1, stale: 0 });
  });

  it("counts a matching ledger row as published and not stale", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("hi") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "hi")], entries, render })).toEqual({
      published: 1, unsynced: 0, stale: 0,
    });
  });

  it("counts an edited-since-upload translation as stale", () => {
    const entries: SyncEntry[] = [
      { itemId: "x:1", stage: "translation", status: "approved", target: "google", contentHash: contentHash("old") },
    ];
    expect(syncSummary({ translations: [t("x:1", "approved", "new")], entries, render })).toEqual({
      published: 1, unsynced: 0, stale: 1,
    });
  });

  it("does not call a migrated row stale", () => {
    const entries: SyncEntry[] = [{ itemId: "x:1", stage: "translation", status: "approved", target: "google" }];
    expect(syncSummary({ translations: [t("x:1", "approved", "anything")], entries, render }).stale).toBe(0);
  });
});

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/status/sync.test.ts`
Expected: FAIL — cannot resolve `src/status/sync`.

- [ ] **Step 3: Create `src/status/sync.ts`**

```ts
import { contentHash, isStale, type SyncEntry } from "../domain/publish/syncLedger";

export interface SyncCounts {
  published: number;
  unsynced: number;
  stale: number;
}

interface Publishable {
  itemId: string;
  status: string;
}

/**
 * `render` produces exactly the bytes the uploader would send, so the hash comparison detects
 * "approved, then edited, but Drive still holds the old version".
 */
export function syncSummary<T extends Publishable>(input: {
  translations: T[];
  entries: SyncEntry[];
  render: (t: T) => string;
}): SyncCounts {
  let published = 0;
  let unsynced = 0;
  let stale = 0;

  for (const t of input.translations) {
    const matches = input.entries.filter((e) => e.itemId === t.itemId && e.status === t.status);
    if (matches.length === 0) {
      unsynced += 1;
      continue;
    }
    published += 1;
    const current = contentHash(input.render(t));
    if (matches.some((e) => isStale(e, current))) stale += 1;
  }

  return { published, unsynced, stale };
}

export function formatSyncSummary(s: SyncCounts): string {
  const parts = [`${s.published} published`];
  if (s.unsynced > 0) parts.push(`${s.unsynced} unsynced`);
  if (s.stale > 0) parts.push(`${s.stale} stale`);
  const warn = s.unsynced > 0 || s.stale > 0 ? "⚠ " : "";
  return `${warn}sync: ${parts.join(" · ")}`;
}
```

Remove the unused `byKey`/`void byKey` lines if the linter objects — they are scaffolding, not required.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/status/sync.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Print it from `status`**

In `src/cli/status.ts`, replace the `published` line and add the summary. The renderer must match what `PublishTranslations` sends:

```ts
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { syncSummary, formatSyncSummary } from "../status/sync";
```

```ts
const entries = await new JsonPublishStore(paths.publishDir).listEntries();
const published = entries.length;

console.log(formatStatus(pipelineStages({ collected, translations, variants, renderings, published })));
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

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm test && pnpm status`
Expected: typecheck clean, tests pass, and `pnpm status` prints the funnel plus a `sync:` line.

- [ ] **Step 7: Commit**

```bash
git add src/status/sync.ts tests/status/sync.test.ts src/cli/status.ts
git commit -m "feat: report published/unsynced/stale counts in pnpm status"
```

---

### Task 5: Split real steering config from tracked examples

**Files:**
- Create: `translation/glossary.example.json`, `translation/locale.example.json`, `translation/few-shot.example.json`, `translation/style-guide.example.md`, `conversion/{x,kol,pr}.example.md`, `conversion/few-shot.{x,kol,pr}.example.json`
- Create: `src/cli/config-init.ts`
- Modify: `.gitignore`, `package.json`, `src/cli/doctor.ts`

**Interfaces:**
- Consumes: `paths.translationConfigDir`, `paths.conversionConfigDir` (Task 1).
- Produces: `pnpm config:init`.

- [ ] **Step 1: Create the example skeletons from the real files**

Each example keeps the *structure* and a single illustrative entry — never the real Mantle corpus.

```bash
node -e "require('fs').writeFileSync('translation/glossary.example.json', JSON.stringify([{term:'Mantle',rule:'keep',target:'Mantle',source:'https://www.mantle.xyz/'}], null, 2)+'\n')"
node -e "require('fs').writeFileSync('translation/few-shot.example.json', '[]\n')"
node -e "require('fs').writeFileSync('conversion/few-shot.x.example.json', '[]\n')"
node -e "require('fs').writeFileSync('conversion/few-shot.kol.example.json', '[]\n')"
node -e "require('fs').writeFileSync('conversion/few-shot.pr.example.json', '[]\n')"
cp translation/locale.json translation/locale.example.json
```

Then hand-write `translation/style-guide.example.md` and `conversion/{x,kol,pr}.example.md` as short generic skeletons — a heading per section the real file has, one sentence of guidance each, and no Mantle-specific tone rules. Read the real file first to mirror its section headings exactly.

Verify `translation/locale.example.json` contains no team-specific content; if it does, replace the values with neutral defaults.

- [ ] **Step 2: Stop tracking the real files**

Add to `.gitignore` (after the existing `# Secrets` block):

```gitignore
# Steering config — the example skeletons are tracked, the real team content is not.
# (Untracking does not erase history; see the storage design spec.)
translation/*
!translation/*.example.json
!translation/*.example.md
conversion/*
!conversion/*.example.json
!conversion/*.example.md
```

```bash
git rm --cached translation/glossary.json translation/locale.json translation/few-shot.json translation/style-guide.md
git rm --cached conversion/x.md conversion/kol.md conversion/pr.md
git rm --cached conversion/few-shot.x.json conversion/few-shot.kol.json conversion/few-shot.pr.json
git status --short
```

Expected: the ten files show as `D` (staged deletion), the `*.example.*` files show as untracked, and the real files still exist on disk.

- [ ] **Step 3: Write `src/cli/config-init.ts`**

```ts
import "./registerErrorHandler";
import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths";

const SUFFIX = ".example";

/** Copy `<name>.example.<ext>` → `<name>.<ext>` when the real file is absent. Never overwrites. */
async function initDir(dir: string): Promise<number> {
  let created = 0;
  const names = await readdir(dir);
  const existing = new Set(names);
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const base = name.slice(0, dot);
    const ext = name.slice(dot);
    if (!base.endsWith(SUFFIX)) continue;
    const target = `${base.slice(0, -SUFFIX.length)}${ext}`;
    if (existing.has(target)) continue;
    await copyFile(join(dir, name), join(dir, target));
    console.log(`  created ${join(dir, target)}`);
    created += 1;
  }
  return created;
}

const created = (await initDir(paths.translationConfigDir)) + (await initDir(paths.conversionConfigDir));
console.log(created === 0 ? "steering config already in place — nothing to do" : `created ${created} file(s)`);
```

Add to `package.json` scripts, after `"glossary"`:

```json
"config:init": "tsx src/cli/config-init.ts",
```

- [ ] **Step 4: Check for the real files in `doctor`**

In `src/cli/doctor.ts`, add near the other config checks:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths";

const steeringFiles = [
  join(paths.translationConfigDir, "glossary.json"),
  join(paths.translationConfigDir, "style-guide.md"),
  join(paths.translationConfigDir, "locale.json"),
  join(paths.conversionConfigDir, "x.md"),
];
const missing: string[] = [];
for (const f of steeringFiles) {
  try {
    await access(f);
  } catch {
    missing.push(f);
  }
}
results.push(
  missing.length === 0
    ? { name: "Steering config", status: "ok", detail: "translation/ + conversion/ present" }
    : { name: "Steering config", status: "fail", detail: `missing ${missing.length} file(s) — run pnpm config:init` },
);
```

Match the `CheckResult` status strings the file already uses — read `src/doctor/report.ts` and use its exact literals rather than assuming `"ok"`/`"fail"`.

- [ ] **Step 5: Verify the fresh-clone path works**

```bash
mkdir -p /tmp/herald-cfg && cp -r translation /tmp/herald-cfg/translation-backup
rm translation/glossary.json
pnpm config:init
node -e "console.log(require('./translation/glossary.json').length, 'entries')"
```

Expected: `config:init` reports `created 1 file(s)` and the restored glossary parses. Then restore the real file:

```bash
cp /tmp/herald-cfg/translation-backup/glossary.json translation/glossary.json
```

Run: `pnpm typecheck && pnpm test && pnpm doctor`
Expected: typecheck clean, tests pass, doctor reports `Steering config … ok`.

- [ ] **Step 6: Commit**

```bash
git add -A .gitignore translation conversion src/cli/config-init.ts src/cli/doctor.ts package.json
git commit -m "chore: track steering config examples only, add pnpm config:init"
```

---

### Task 6: Archive on overwrite + atomic pending writes

Closes the data-loss path where a second `prepare` before `save` strands the first batch, and brings the three CLI-level `pending.json` writes onto the atomic helper every store already uses.

Archiving a replaced `pending.json` is **unconditional, in both modes** — see the spec's §1.5. The batch it rescues is unsaved work that no Drive copy covers in either mode, and a mode branch would leave the destructive path less tested. Worksheets are swept on demand by `pnpm archive` (Task 7).

**Files:**
- Create: `src/shared/store/archive.ts`
- Create: `tests/shared/store/archive.test.ts`
- Modify: `src/cli/translate-prepare.ts:42-49`, `src/cli/convert-prepare.ts:50-54`, `src/cli/format.ts:35-39`, `src/cli/translate-save.ts:17-21`, `src/cli/format-save.ts:20-24`

**Interfaces:**
- Consumes: `paths.archiveDir`, `paths.*Pending` (Task 1); `writeJsonFileAtomic` from `src/shared/store/jsonFile`.
- Produces: `archiveFile(srcPath: string, archiveRoot: string, label: string, now?: Date): Promise<string | null>` — returns the destination path, or `null` when the source does not exist.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/store/archive.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveFile } from "../../../src/shared/store/archive";

describe("archiveFile", () => {
  it("moves the file into a dated folder and returns the destination", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    const src = join(dir, "pending.json");
    await writeFile(src, '{"a":1}', "utf8");
    const root = join(dir, "archive");

    const dest = await archiveFile(src, root, "pending-translations", new Date("2026-07-20T09:30:15.000Z"));

    expect(dest).not.toBeNull();
    expect(dest).toContain(join("archive", "2026-07-20"));
    expect(await readFile(dest as string, "utf8")).toBe('{"a":1}');
    await expect(readFile(src, "utf8")).rejects.toThrow();
  });

  it("returns null when there is nothing to archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    expect(await archiveFile(join(dir, "absent.json"), join(dir, "archive"), "x")).toBeNull();
  });

  it("does not collide when archiving twice in the same second", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-"));
    const root = join(dir, "archive");
    const at = new Date("2026-07-20T09:30:15.000Z");
    for (const body of ["one", "two"]) {
      await writeFile(join(dir, "pending.json"), body, "utf8");
      await archiveFile(join(dir, "pending.json"), root, "pending", at);
    }
    expect(await readdir(join(root, "2026-07-20"))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/store/archive.test.ts`
Expected: FAIL — cannot resolve `src/shared/store/archive`.

- [ ] **Step 3: Create `src/shared/store/archive.ts`**

```ts
import { mkdir, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Move a file into `<archiveRoot>/<YYYY-MM-DD>/<label>-<HHmmss>-<short>.<ext>`.
 * Returns the destination, or null when the source does not exist (nothing to preserve).
 */
export async function archiveFile(
  srcPath: string,
  archiveRoot: string,
  label: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    await stat(srcPath);
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }

  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replaceAll(":", "");
  const dir = join(archiveRoot, day);
  await mkdir(dir, { recursive: true });

  const dest = join(dir, `${label}-${time}-${randomUUID().slice(0, 8)}${extname(srcPath)}`);
  await rename(srcPath, dest);
  return dest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/store/archive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Archive before overwriting, and write atomically**

`src/cli/translate-prepare.ts` — replace the `writeFile(join("output/translations", "pending.json"), …)` call (line 47 area) with:

```ts
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
```

```ts
const archived = await archiveFile(paths.translationsPending, paths.archiveDir, "pending-translations");
if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
await writeJsonFileAtomic(paths.translationsDir, paths.translationsPending, pending);
```

`src/cli/convert-prepare.ts` — same shape at line 54:

```ts
const archived = await archiveFile(paths.variantsPending, paths.archiveDir, "pending-variants");
if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
await writeJsonFileAtomic(paths.variantsDir, paths.variantsPending, pending);
```

`src/cli/format.ts` — same shape at line 39:

```ts
const archived = await archiveFile(paths.formattedPending, paths.archiveDir, "pending-formatted");
if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
await writeJsonFileAtomic(paths.formattedDir, paths.formattedPending, pending);
```

Remove the now-unused `writeFile` import from each file if nothing else uses it. Note `writeJsonFileAtomic` already appends the trailing newline and pretty-prints with 2 spaces, matching the previous output byte for byte.

- [ ] **Step 6: Give `translate:save` and `format:save` the fallback `convert:save` already has**

In `src/cli/translate-save.ts`, replace lines 17-25 (the pending lookup, the throw, and the store construction) with the block below. `ContentItem` is `{ id, source, text, createdAt, refUrl? }` and `Translation` is `{ itemId, source, sourceText, koreanText, status, translatedAt, approvedAt? }`, so a saved translation reconstitutes a `ContentItem` exactly. The `usecase.run({...})` call below it stays unchanged — it already reads `item.id` / `item.source` / `item.text`.

```ts
const translationStore = new JsonTranslationStore(paths.translationsDir);

const pending = await readJsonFile<ContentItem[]>(paths.translationsPending, []);
let item = pending.find((p) => p.id === id);
if (!item) {
  // Not in the current worksheet batch — fall back to an already-saved translation, so you
  // can re-save or re-approve an item after pending.json was replaced by a later prepare.
  const saved = (await translationStore.loadAll()).find((t) => t.itemId === id);
  if (saved) {
    item = { id: saved.itemId, source: saved.source, text: saved.sourceText, createdAt: saved.translatedAt };
  }
}
if (!item) {
  throw new Error(`Item ${id} not found in ${paths.translationsPending} or the saved translations (run translate:prepare first)`);
}

const koreanText = (await readFile(file, "utf8")).trim();

const usecase = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir));
```

In `src/cli/format-save.ts`, replace lines 20-24 the same way. `PendingRendering` is only `{ itemId, type, channel }`, so the fallback just has to confirm the rendering already exists:

```ts
const formattingStore = new JsonFormattingStore(paths.formattedDir);

const pending = await readJsonFile<PendingRendering[]>(paths.formattedPending, []);
let match = pending.find((p) => p.itemId === id && p.type === type && p.channel === channel);
if (!match) {
  // Not in the current refinement batch — fall back to an already-saved rendering, so you can
  // re-refine after pending.json was replaced by a later format --refine.
  const saved = (await formattingStore.loadAll()).find(
    (r) => r.itemId === id && r.type === type && r.channel === channel,
  );
  if (saved) match = { itemId: saved.itemId, type: saved.type, channel: saved.channel };
}
if (!match) {
  throw new Error(`Rendering ${id}/${type}/${channel} not found in ${paths.formattedPending} or the saved renderings (run format --refine first)`);
}
```

Then change the `SaveRendering` construction on the last line to reuse the store: `new SaveRendering(formattingStore)`.

- [ ] **Step 7: Verify the loss path is closed**

```bash
pnpm translate:prepare --limit 1
cp output/translations/pending.json /tmp/first-batch.json
pnpm translate:prepare --limit 1
ls output/archive/*/
```

Expected: the second `prepare` prints `archived the previous unsaved batch → …` and the archived file matches `/tmp/first-batch.json`.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/shared/store/archive.ts tests/shared/store/archive.test.ts src/cli
git commit -m "fix: archive the previous pending batch and write pending.json atomically"
```

---

### Task 7: `pnpm archive` and `pnpm clean`

**Files:**
- Create: `src/storage/retention.ts`, `tests/storage/retention.test.ts`, `src/cli/archive.ts`, `src/cli/clean.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `paths.*Worksheets`, `paths.archiveDir`, `OUTPUT_DIR` (Task 1); `archiveFile` (Task 6); `argValue` from `src/cli/args`.
- Produces: `expiredArchiveDays(names: string[], olderThanDays: number, now: Date): string[]`; `isStrandedTempFile(name: string): boolean`; `pnpm archive`; `pnpm clean`.

- [ ] **Step 1: Write the failing test**

Create `tests/storage/retention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expiredArchiveDays, isStrandedTempFile } from "../../src/storage/retention";

const now = new Date("2026-07-20T12:00:00.000Z");

describe("expiredArchiveDays", () => {
  it("keeps folders inside the retention window", () => {
    expect(expiredArchiveDays(["2026-07-19", "2026-06-25"], 30, now)).toEqual([]);
  });

  it("expires folders older than the window", () => {
    expect(expiredArchiveDays(["2026-06-19", "2026-07-19"], 30, now)).toEqual(["2026-06-19"]);
  });

  it("treats the boundary day as still within the window", () => {
    expect(expiredArchiveDays(["2026-06-20"], 30, now)).toEqual([]);
  });

  it("ignores anything that is not a date folder", () => {
    expect(expiredArchiveDays(["notes", "2026-13-45", ".DS_Store"], 30, now)).toEqual([]);
  });
});

describe("isStrandedTempFile", () => {
  it("matches the atomic-write temp pattern", () => {
    expect(isStrandedTempFile("items.json.tmp-4821-1750000000000-3f2b1c9d-aaaa-bbbb-cccc-ddddeeeeffff")).toBe(true);
  });

  it("never matches a live store", () => {
    expect(isStrandedTempFile("items.json")).toBe(false);
    expect(isStrandedTempFile("state.json")).toBe(false);
    expect(isStrandedTempFile("pending.json")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/storage/retention.test.ts`
Expected: FAIL — cannot resolve `src/storage/retention`.

- [ ] **Step 3: Create `src/storage/retention.ts`**

```ts
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** Matches the suffix writeJsonFileAtomic appends: `.tmp-<pid>-<ms>-<uuid>`. */
const TEMP_FILE = /\.tmp-\d+-\d+-[0-9a-f-]+$/i;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Archive day-folders strictly older than the retention window. Unparseable names are left alone. */
export function expiredArchiveDays(names: string[], olderThanDays: number, now: Date): string[] {
  const cutoff = now.getTime() - olderThanDays * MS_PER_DAY;
  return names.filter((name) => {
    if (!DAY_FOLDER.test(name)) return false;
    const at = Date.parse(`${name}T00:00:00.000Z`);
    if (Number.isNaN(at)) return false;
    return at < cutoff;
  });
}

export function isStrandedTempFile(name: string): boolean {
  return TEMP_FILE.test(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/storage/retention.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the two CLIs**

Create `src/cli/archive.ts`:

```ts
import "./registerErrorHandler";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths";
import { archiveFile } from "../shared/store/archive";

const worksheetDirs: Array<[string, string]> = [
  [paths.translationsWorksheets, "worksheet-translations"],
  [paths.variantsWorksheets, "worksheet-variants"],
  [paths.formattedWorksheets, "worksheet-formatted"],
];

let moved = 0;
for (const [dir, label] of worksheetDirs) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    continue; // stage never ran
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const dest = await archiveFile(join(dir, name), paths.archiveDir, label);
    if (dest) {
      console.log(`  ${name} → ${dest}`);
      moved += 1;
    }
  }
}

console.log(moved === 0 ? "nothing to archive" : `archived ${moved} worksheet(s)`);
```

Create `src/cli/clean.ts`:

```ts
import "./registerErrorHandler";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { argValue } from "./args";
import { OUTPUT_DIR, paths } from "../paths";
import { expiredArchiveDays, isStrandedTempFile } from "../storage/retention";

const olderThanDays = Number(argValue("--older-than") ?? "30");
if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
  throw new Error(`Invalid --older-than: ${argValue("--older-than")} (expected a non-negative number of days)`);
}
const confirmed = process.argv.includes("--yes");

const targets: string[] = [];

// 1. Expired archive day-folders.
try {
  const days = await readdir(paths.archiveDir);
  for (const day of expiredArchiveDays(days, olderThanDays, new Date())) {
    targets.push(join(paths.archiveDir, day));
  }
} catch {
  // no archive yet
}

// 2. Temp files stranded by an interrupted atomic write. Live stores are never matched.
async function sweepTemp(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (isStrandedTempFile(name)) {
      targets.push(full);
      continue;
    }
    if ((await stat(full)).isDirectory() && full !== paths.archiveDir) await sweepTemp(full);
  }
}
await sweepTemp(OUTPUT_DIR);

if (targets.length === 0) {
  console.log("nothing to clean");
} else if (!confirmed) {
  console.log(`would remove ${targets.length} path(s) (older than ${olderThanDays} day(s)):`);
  for (const t of targets) console.log(`  ${t}`);
  console.log("\nre-run with --yes to remove them");
} else {
  for (const t of targets) await rm(t, { recursive: true, force: true });
  console.log(`removed ${targets.length} path(s)`);
}
```

Add to `package.json` scripts, after `"status"`:

```json
"archive": "tsx src/cli/archive.ts",
"clean": "tsx src/cli/clean.ts",
```

- [ ] **Step 6: Verify the dry-run default**

```bash
pnpm archive
pnpm clean
pnpm clean --older-than 0
```

Expected: `pnpm archive` moves any worksheets into `output/archive/<today>/`; `pnpm clean` prints `nothing to clean` (today's archive is inside the 30-day window); `pnpm clean --older-than 0` **lists** today's archive folder and prints `re-run with --yes to remove them` without deleting anything. Confirm the folder still exists afterwards.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/storage/retention.ts tests/storage/retention.test.ts src/cli/archive.ts src/cli/clean.ts package.json
git commit -m "feat: pnpm archive and pnpm clean for worksheet retention"
```

---

### Task 8: `docs/ko/artifacts.md` — the request → artifact map

Written first among the documents because it is the reference the other three cite.

**Files:**
- Create: `docs/ko/artifacts.md`, `docs/en/.gitkeep`

**Interfaces:**
- Consumes: everything from Tasks 1–7 — this document describes their final state.
- Produces: the canonical artifact reference the other documents link to.

- [ ] **Step 1: Confirm the command list is current**

Run: `node -e "console.log(Object.keys(require('./package.json').scripts).join('\n'))"`
Expected: includes `config:init`, `archive`, `clean` from the earlier tasks. Every script name in the document must come from this output.

- [ ] **Step 2: Write the document**

Create `docs/ko/artifacts.md`, in Korean, with these sections:

1. **저장 계층** — the tier table from the spec (code+docs / steering examples / steering actual / workspace / record of truth / publish log), with the git column.
2. **저장 모드** — `HERALD_STORAGE_MODE=local|cloud`, the behaviour table, and how to promote from `local` to `cloud`.
3. **명령어별 입출력** — one table row per script, columns `명령어 | 읽는 것 | 쓰는 것 | 외부 시스템`. Use the real paths from `src/paths.ts`. The content is the survey already captured in the design spec's Context section, updated for the new ledger and archive behaviour. Cover all of: `collect`, `collect-lark`, `lark:chats`, `lark:send`, `reconcile`, `translate:prepare`, `translate:save`, `convert:prepare`, `convert:save`, `format`, `format:save`, `glossary`, `config:init`, `drive:publish`, `drive:init`, `targets:list`, `history:record`, `sheet:init`, `doctor`, `status`, `archive`, `clean`, `serve`, `google:auth`.
4. **동기화 원장** — the `SyncEntry` schema with a real example, what `contentHash` detects, and that legacy rows migrate on read with unknown fields left empty.
5. **보존 정책** — `output/archive/<YYYY-MM-DD>/`, what `pnpm archive` sweeps, `pnpm clean` defaulting to a 30-day window and dry-run unless `--yes`.
6. **잃으면 안 되는 것 vs 지워도 되는 것** — two explicit lists. Must-keep: `output/translations/translations.json`, `output/variants/variants.json`, `output/formatted/renderings.json`, the real `translation/`+`conversion/` steering files, `output/{x,lark}/state.json` watermarks. Safe to delete: worksheets after archiving, expired archive folders, `.tmp-*` files, and `output/{x,lark}/items.json` (re-collectable).
7. **알려진 마찰** — the naming inconsistencies deliberately left alone: `output/formatted/renderings.json` and `output/publish/state.json` do not match their directory names, and `state.json` means a watermark map under `x`/`lark` but the sync ledger under `publish`. Note that renaming would require migrating existing local data for no functional gain.

Create `docs/en/.gitkeep` (empty) so the reserved English folder exists in git.

- [ ] **Step 3: Verify every command and path named is real**

Run: `grep -oE 'pnpm [a-z:]+' docs/ko/artifacts.md | sort -u`
Expected: every entry appears in the `package.json` script list from Step 1.

Run: `grep -oE 'output/[a-z/.<>-]+' docs/ko/artifacts.md | sort -u`
Expected: every path corresponds to a key in `src/paths.ts` (allowing `<YYYY-MM-DD>` placeholders under `output/archive/`).

- [ ] **Step 4: Commit**

```bash
git add docs/ko/artifacts.md docs/en/.gitkeep
git commit -m "docs: add the request → artifact map (ko)"
```

---

### Task 9: `docs/ko/capabilities.md` + reduced `README.md`

**Files:**
- Create: `docs/ko/capabilities.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `docs/ko/artifacts.md` (Task 8) — linked, not duplicated.
- Produces: the document `quickstart.md` and `team-runbook.md` both open with.

- [ ] **Step 1: Write `docs/ko/capabilities.md`**

In Korean:

1. **한 문단 요약** — what the project is.
2. **파이프라인** — the stages in order with their owning commands: 수집(`collect`, `collect-lark`) → 번역(`translate:prepare`/`translate:save`) → 1차 검수(`serve`) → 변환(`convert:prepare`/`convert:save`) → 채널 포맷(`format`/`format:save`) → 2차 검수(`serve`) → 발행(`drive:publish`) → 기록(`history:record`). Include an ASCII or mermaid diagram.
3. **지원 범위** — sources (X via twitterapi.io, Lark groups), channels (x / telegram / kakao / pr_mail), stores (Google Drive, Lark Drive, Google Sheet).
4. **할 수 없는 것** — required, and stated as plainly as the "can" list: no automatic posting to any channel; translation and conversion are performed by a local Claude Code agent filling worksheets, never the Claude API; every run is local to one operator's machine; Lark is not yet a formatting channel; impressions (§9b) are not implemented.
5. **모듈 지도** — the A–G table currently in `README.md`, moved here, each row linking to the relevant guide.
6. **다음으로** — links to `quickstart.md` (external), `team-runbook.md` (internal), `artifacts.md` (where things are stored).

- [ ] **Step 2: Reduce `README.md`**

Replace the whole file with: the project name and one-line description; a 5-line quick start (`pnpm install`, `cp .env.example .env`, `pnpm config:init`, `pnpm doctor`, `pnpm status`); and a document map table linking `docs/ko/capabilities.md`, `docs/ko/quickstart.md`, `docs/ko/team-runbook.md`, `docs/ko/artifacts.md`, `docs/README.md`, `docs/architecture/`, `CHANGELOG.md`.

Remove the pointer to `docs/superpowers/specs/` — that is a development-history archive, not user documentation. The per-module A–G reference is now in `capabilities.md` and must not be duplicated here.

- [ ] **Step 3: Verify the links resolve**

Run:
```bash
grep -oE '\]\([^)#][^)]*\)' README.md docs/ko/capabilities.md | sed -E 's/.*\(([^)]*)\)/\1/' | grep -v '^http' | sort -u
```
Then check each printed path exists relative to its file. Expected: no missing targets.

- [ ] **Step 4: Commit**

```bash
git add docs/ko/capabilities.md README.md
git commit -m "docs: add the capabilities overview (ko), reduce README to a hub"
```

---

### Task 10: `quickstart.md`, `team-runbook.md`, `docs/README.md`

**Files:**
- Create: `docs/ko/quickstart.md`, `docs/ko/team-runbook.md`, `docs/README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 8 and 9; the existing `docs/guides/*.md` (linked as the setup SSOT, never restated).
- Produces: the complete documentation set.

- [ ] **Step 1: Write `docs/ko/quickstart.md`** (external / open-source readers, Korean)

1. **준비물** — a checklist, leading with the fact that **every credential is optional**: with `HERALD_STORAGE_MODE=local` the collect/translate/convert/format stages run with no API keys. Required: Node + pnpm, and Claude Code for the agent-assisted stages. Optional: twitterapi.io key (X collection), Lark app (Lark collection/send), Google OAuth (Drive + Sheet). Each optional row links to the relevant `docs/guides/` document — **do not restate the procedures**.
2. **5분 시작** — `pnpm install` → `cp .env.example .env` → `pnpm config:init` → `pnpm doctor` → `pnpm status`.
3. **첫 배치** — a worked example through `translate:prepare` → agent fills the worksheet → `translate:save --approve`, noting the agent does the translation.
4. **우리 팀에 맞추기** — edit the real `translation/glossary.json`, `style-guide.md`, `locale.json` and `conversion/*.md` that `config:init` created; note these are git-ignored and are yours to keep.
5. **local → cloud 승격** — set up Google/Lark per the guides, flip `HERALD_STORAGE_MODE=cloud`, run `pnpm doctor --live`, then `pnpm drive:publish` to upload the backlog. Explain that the ledger means already-uploaded items are skipped.

- [ ] **Step 2: Write `docs/ko/team-runbook.md`** (internal readers, Korean)

1. **준비물** — our concrete assets: the Lark app and operating group, `LARK_CHAT_IDS`, the Google Drive review/approved folders, `GSHEET_ID`, and `HERALD_STORAGE_MODE=cloud`. Values live in `.env`, never in the document — reference the variable names only.
2. **주간 루틴** — the ordered command sequence for a normal week, with who does what at each review gate.
3. **검수 기준** — link to `translation/style-guide.md` and `conversion/*.md`; do not restate the rules.
4. **사고 대응** — the three confirmed failure modes, each with symptom → cause → fix:
   - *미동기화가 밀렸을 때* — `pnpm status` shows `⚠ sync: … N unsynced`; run `pnpm drive:publish`. If it shows `stale`, the item was edited after upload; re-publishing uploads a fresh copy.
   - *`pending.json`을 날렸을 때* — a second `prepare` before saving archives the previous batch to `output/archive/<날짜>/pending-*.json`; restore it, or re-run `prepare` for the same ids.
   - *워터마크가 꼬였을 때* — `output/{x,lark}/state.json` holds the collection watermarks; deleting one causes a full re-collect, editing the timestamp backwards re-collects from that point.
5. **정리 주기** — run `pnpm archive` after each batch and `pnpm clean` monthly, with `pnpm clean` listing before deleting unless `--yes`.

- [ ] **Step 3: Write `docs/README.md`** (English, developers)

1. **Folder map** — a table of `ko/`, `en/`, `architecture/`, `guides/`, `superpowers/` with each folder's audience, language and purpose. Note that `superpowers/` is a development-history archive, not user documentation.
2. **Where does a new document go?** — a short decision tree.
3. **Rules** — the three from the spec, stated as rules with their reasons:
   - **SSOT** — setup *procedures* live only in `guides/`; everywhere else links. Without this the prerequisites sections of `quickstart.md` and `team-runbook.md` become a third and fourth copy.
   - **Locale** — `ko/` is the source of truth, `en/` a translation; Korean is updated first, and an English page must never be the only place a fact exists.
   - **Companion updates** — adding a CLI requires updating `docs/ko/capabilities.md`, `docs/ko/artifacts.md` and `.env.example` in the same change; changing an artifact path requires updating `src/paths.ts` and `docs/ko/artifacts.md` together.

- [ ] **Step 4: Update `CHANGELOG.md`**

Under `## [Unreleased]`, add to `### Added`:

```markdown
- **Explicit storage mode** — `HERALD_STORAGE_MODE=local|cloud` decides whether Drive is the record
  of truth or everything stays local. `local` runs the whole pipeline with no credentials at all and
  skips the cloud commands with a clear message; `cloud` behaves as before. Never inferred.
- **Sync ledger** — `output/publish/state.json` now records which drive, remote id, URL, filename,
  content hash and timestamp for every upload (legacy key sets migrate on read). `pnpm status`
  reports published / unsynced / stale counts, so an item edited after publishing is visible.
- **`pnpm archive` / `pnpm clean`** — retention for worksheets and superseded batches under
  `output/archive/<date>/`; `clean` removes archives older than 30 days (`--older-than`) and temp
  files stranded by interrupted writes, listing them unless `--yes` is passed.
- **`pnpm config:init`** — creates the steering config from the tracked `*.example.*` skeletons.
- **Documentation set** — `docs/ko/{capabilities,quickstart,team-runbook,artifacts}.md` covering what
  the project does, how external and internal users run it, and where every artifact is stored;
  `docs/README.md` records the documentation rules.
```

Add to `### Fixed`:

```markdown
- **Artifact paths are anchored to the repo root**, not the process CWD. Running a command from a
  subdirectory silently created a second `output/` tree; all 36 path literals now come from
  `src/paths.ts`.
- **`prepare` no longer strands an unsaved batch.** `translate:prepare`, `convert:prepare` and
  `format --refine` archive the previous `pending.json` before replacing it and write it atomically
  like every other store; `translate:save` and `format:save` fall back to an already-saved item
  instead of throwing.
```

Add to `### Changed`:

```markdown
- **The real steering config left git.** `translation/` and `conversion/` now track only
  `*.example.*` skeletons; the actual glossary, style guide and few-shot corpus are local. Routine
  approvals no longer dirty the working tree.
```

- [ ] **Step 5: Verify the whole documentation set**

Run:
```bash
grep -rhoE '\]\([^)#][^)]*\)' README.md docs/README.md docs/ko/*.md | sed -E 's/.*\(([^)]*)\)/\1/' | grep -v '^http' | sort -u
```
Check each path exists relative to its containing file. Expected: no broken links.

Run: `grep -rn 'TODO\|TBD\|<채워넣기>' docs/ko/ docs/README.md README.md`
Expected: no output.

Run: `pnpm typecheck && pnpm test`
Expected: typecheck clean, full suite passes.

- [ ] **Step 6: Commit**

```bash
git add docs/ko docs/README.md CHANGELOG.md
git commit -m "docs: add quickstart, team runbook and documentation rules"
```

---

## Final verification

- [ ] `pnpm typecheck && pnpm typecheck:web && pnpm test` — all clean.
- [ ] `grep -rn '"output/' src/` — no output.
- [ ] `pnpm doctor` — reports the storage mode and steering-config state.
- [ ] `pnpm status` — prints the funnel plus the `sync:` line.
- [ ] `HERALD_STORAGE_MODE=local pnpm drive:publish` — skips with exit 0.
- [ ] `git status --short` — clean; the real steering files are untracked and still present on disk.
- [ ] Follow `docs/ko/quickstart.md` from a clean clone in `local` mode and confirm each step works as written.
