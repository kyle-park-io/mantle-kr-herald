# Item Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each stage's output per item in an append-only per-item lineage, so align/refine/approve no longer lose the prior version, and `pnpm lineage <id>` shows the item's journey with per-revision diffs.

**Architecture:** A `LineageStore` port + `JsonlLineageStore` adapter writing `output/lineage/<safeId>.jsonl`. The four save use-cases (`SaveTranslation`, `SaveConversion`, `SaveRendering`, `ApproveRendering`) take an optional `LineageStore` and best-effort append a snapshot after their write. A pure `renderLineage` builds the journey + diff for the `pnpm lineage` CLI. No behavior change when the store is absent; stores themselves are untouched.

**Tech Stack:** ESM TypeScript, `vitest`, `tsx`, `zod`-only runtime dep, `node:fs/promises`.

## Global Constraints

- Runtime deps stay **zod-only**; no new dependency; no network call. Append uses `fs.appendFile`.
- **Best-effort:** lineage NEVER breaks or blocks a save — every append is wrapped in try/catch; an absent `LineageStore` is a pure no-op. The instrumented use-cases keep their existing return values and behavior when no store is injected.
- The content stores (`translations.json` etc.) are **untouched** — capture happens in the use-cases.
- `output/lineage/` is git-ignored local scratch (under `output/`). Tests use synthetic items only.
- Stages captured (v1): `translated`, `converted`, `rendered`. Source (원문) rides the `translated` entry's `sourceText`. `sent`/`collected`, trigger labels, dashboard, rollback are out (non-goals).
- Every test can fail: pin concrete stage/variant/content strings.

---

## File Structure

- **Create** `src/domain/lineage/models.ts` — `LineageEntry`, `LineageStage`.
- **Create** `src/ports/LineageStore.ts` — the port + `LineageSummary`.
- **Create** `src/adapters/store/JsonlLineageStore.ts` — the JSONL adapter.
- **Create** `src/domain/lineage/render.ts` — pure `renderLineage`.
- **Modify** `src/paths.ts` — add `lineageDir`.
- **Modify** `src/app/{SaveTranslation,SaveConversion,SaveRendering,ApproveRendering}.ts` — optional `lineage?` + best-effort append.
- **Create** `src/cli/lineage.ts` (the CLI) + `src/cli/lineage-wiring.ts` (`buildLineage`).
- **Modify** `src/cli/{translate-save,convert-save,format-save,serve}.ts` — inject `buildLineage()`.
- **Modify** `package.json` (script), `CHANGELOG.md`, `docs/ko/capabilities.md`.
- **Tests:** `tests/adapters/jsonlLineageStore.test.ts`, `tests/domain/lineage/render.test.ts`, and lineage-append cases added to each use-case's test area (or a new `tests/app/lineageCapture.test.ts`).

---

## Task 1: Lineage model + port + JSONL adapter

**Files:**
- Create: `src/domain/lineage/models.ts`, `src/ports/LineageStore.ts`, `src/adapters/store/JsonlLineageStore.ts`
- Modify: `src/paths.ts`
- Test: `tests/adapters/jsonlLineageStore.test.ts`

**Interfaces:**
- Produces: `LineageEntry`, `LineageStage`, `LineageStore`, `LineageSummary`, `JsonlLineageStore`.

- [ ] **Step 1: Create the model** `src/domain/lineage/models.ts`

```ts
export type LineageStage = "translated" | "converted" | "rendered";

export interface LineageEntry {
  itemId: string;
  stage: LineageStage;
  variant?: string; // stage qualifier: type ("announcement") or "type/channel" ("announcement/telegram")
  content: string; // the meaningful text produced at this stage
  status?: string; // the record's status at this point
  sourceText?: string; // only on a "translated" entry: the English 원문
  at: string; // ISO timestamp
}
```

- [ ] **Step 2: Create the port** `src/ports/LineageStore.ts`

```ts
import type { LineageEntry, LineageStage } from "../domain/lineage/models";

export interface LineageSummary {
  itemId: string;
  entries: number;
  lastStage: LineageStage;
}

export interface LineageStore {
  append(entry: LineageEntry): Promise<void>;
  load(itemId: string): Promise<LineageEntry[]>;
  listItems(): Promise<LineageSummary[]>;
}
```

- [ ] **Step 3: Add the path** — in `src/paths.ts`, add to the paths object (next to the other `output/` dirs):

```ts
  lineageDir: join(OUTPUT_DIR, "lineage"),
```

- [ ] **Step 4: Write the failing adapter tests** `tests/adapters/jsonlLineageStore.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlLineageStore } from "../../src/adapters/store/JsonlLineageStore";
import type { LineageEntry } from "../../src/domain/lineage/models";

const entry = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "안녕", status: "translated", at: "2026-07-28T00:00:00.000Z", ...over,
});

describe("JsonlLineageStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lineage-")); });

  it("appends and loads entries in order for an id containing ':'", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry({ content: "v1" }));
    await s.append(entry({ content: "v2" }));
    const got = await s.load("x:1");
    expect(got.map((e) => e.content)).toEqual(["v1", "v2"]);
  });

  it("writes to a ':'-sanitized filename (x:1 -> x_1.jsonl)", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry());
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toContain("x_1.jsonl");
  });

  it("returns [] for an item with no file", async () => {
    expect(await new JsonlLineageStore(dir).load("x:404")).toEqual([]);
  });

  it("skips a malformed line and loads the rest", async () => {
    await writeFile(join(dir, "x_1.jsonl"), JSON.stringify(entry({ content: "ok" })) + "\n{bad json\n", "utf8");
    const got = await new JsonlLineageStore(dir).load("x:1");
    expect(got.map((e) => e.content)).toEqual(["ok"]);
  });

  it("listItems reports id, entry count, and last stage", async () => {
    const s = new JsonlLineageStore(dir);
    await s.append(entry({ stage: "translated" }));
    await s.append(entry({ stage: "converted", variant: "announcement" }));
    expect(await s.listItems()).toEqual([{ itemId: "x:1", entries: 2, lastStage: "converted" }]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/adapters/jsonlLineageStore.test.ts`
Expected: FAIL — adapter not found.

- [ ] **Step 6: Implement** `src/adapters/store/JsonlLineageStore.ts`

```ts
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LineageEntry } from "../../domain/lineage/models";
import type { LineageStore, LineageSummary } from "../../ports/LineageStore";

// itemIds are "<source>:<id>" — only the source separator is a ':'. Replace it for a safe filename.
const safeName = (itemId: string) => `${itemId.replace(/:/g, "_")}.jsonl`;

function parseLines(raw: string): LineageEntry[] {
  const out: LineageEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LineageEntry);
    } catch {
      console.warn(`[lineage] skipping malformed line`);
    }
  }
  return out;
}

export class JsonlLineageStore implements LineageStore {
  constructor(private readonly dir: string) {}

  async append(entry: LineageEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, safeName(entry.itemId)), JSON.stringify(entry) + "\n", "utf8");
  }

  async load(itemId: string): Promise<LineageEntry[]> {
    try {
      return parseLines(await readFile(join(this.dir, safeName(itemId)), "utf8"));
    } catch {
      return [];
    }
  }

  async listItems(): Promise<LineageSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: LineageSummary[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      // Reconstruct the real itemId from the entries (avoids ambiguous '_' -> ':' reversal).
      const entries = parseLines(await readFile(join(this.dir, f), "utf8"));
      if (entries.length === 0) continue;
      out.push({ itemId: entries[0].itemId, entries: entries.length, lastStage: entries[entries.length - 1].stage });
    }
    return out;
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/jsonlLineageStore.test.ts`
Expected: PASS (5/5).

- [ ] **Step 8: Commit**

```bash
git add src/domain/lineage/models.ts src/ports/LineageStore.ts src/adapters/store/JsonlLineageStore.ts src/paths.ts tests/adapters/jsonlLineageStore.test.ts
git commit -m "feat(lineage): LineageEntry model + JsonlLineageStore (append-only per-item)"
```

---

## Task 2: `renderLineage` pure view

**Files:**
- Create: `src/domain/lineage/render.ts`
- Test: `tests/domain/lineage/render.test.ts`

**Interfaces:**
- Consumes: `LineageEntry` from `./models`.
- Produces: `renderLineage(entries: LineageEntry[]): string`.

- [ ] **Step 1: Write the failing test** `tests/domain/lineage/render.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { renderLineage } from "../../../src/domain/lineage/render";
import type { LineageEntry } from "../../../src/domain/lineage/models";

const e = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "안녕", status: "translated", at: "T1", ...over,
});

describe("renderLineage", () => {
  it("shows 원문 on the first translated entry and its content", () => {
    const out = renderLineage([e({ sourceText: "hi", content: "안녕" })]);
    expect(out).toContain("translated");
    expect(out).toContain("원문:\nhi");
    expect(out).toContain("안녕");
  });

  it("diffs two same-stage entries: names removed and added lines", () => {
    const out = renderLineage([
      e({ content: "네이티브 AMM 뎁스", at: "T1" }),
      e({ content: "네이티브 AMM 유동성", at: "T2" }),
    ]);
    expect(out).toContain("- 네이티브 AMM 뎁스");
    expect(out).toContain("+ 네이티브 AMM 유동성");
  });

  it("notes a status change when content is unchanged (approve)", () => {
    const out = renderLineage([
      e({ stage: "rendered", variant: "announcement/telegram", content: "본문", status: "rendered", at: "T1" }),
      e({ stage: "rendered", variant: "announcement/telegram", content: "본문", status: "approved", at: "T2" }),
    ]);
    expect(out).toContain("상태: rendered → approved");
  });

  it("renders entries across stages in order", () => {
    const out = renderLineage([
      e({ stage: "translated", content: "번역", at: "T1" }),
      e({ stage: "converted", variant: "announcement", content: "공지", at: "T2" }),
    ]);
    expect(out.indexOf("translated")).toBeLessThan(out.indexOf("converted"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/lineage/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/domain/lineage/render.ts`

```ts
import type { LineageEntry } from "./models";

// A minimal, order-independent line diff: lines present in one side only. Enough to show a
// single-line revision (e.g. 뎁스 → 유동성) without pulling in a diff library (zod-only).
function diffContent(prev: string, cur: string): string {
  const p = new Set(prev.split("\n"));
  const c = new Set(cur.split("\n"));
  const removed = [...p].filter((l) => l.trim() && !c.has(l)).map((l) => `  - ${l}`);
  const added = [...c].filter((l) => l.trim() && !p.has(l)).map((l) => `  + ${l}`);
  const body = [...removed, ...added].join("\n");
  return body || "  (내용 동일)";
}

export function renderLineage(entries: LineageEntry[]): string {
  const out: string[] = [];
  const prevByKey = new Map<string, LineageEntry>();
  for (const e of entries) {
    const key = `${e.stage}|${e.variant ?? ""}`;
    const prev = prevByKey.get(key);
    const variant = e.variant ? `(${e.variant})` : "";
    const status = e.status ? ` [${e.status}]` : "";
    out.push(`── ${e.at} · ${e.stage}${variant}${status}`);
    if (e.stage === "translated" && !prev && e.sourceText) out.push("원문:", e.sourceText);
    if (!prev) {
      out.push("내용:", e.content);
    } else {
      out.push("변경:", diffContent(prev.content, e.content));
      if (prev.status !== e.status) out.push(`상태: ${prev.status ?? "-"} → ${e.status ?? "-"}`);
    }
    out.push("");
    prevByKey.set(key, e);
  }
  return out.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/domain/lineage/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/lineage/render.ts tests/domain/lineage/render.test.ts
git commit -m "feat(lineage): renderLineage — journey + per-revision line diff"
```

---

## Task 3: Best-effort lineage capture in the four save use-cases

**Files:**
- Modify: `src/app/SaveTranslation.ts`, `src/app/SaveConversion.ts`, `src/app/SaveRendering.ts`, `src/app/ApproveRendering.ts`
- Test: `tests/app/lineageCapture.test.ts`

**Interfaces:**
- Consumes: `LineageStore` from `../ports/LineageStore`; existing input/record types.
- Each use-case gains an optional final ctor arg `lineage?: LineageStore` (added **after** `now`, so existing call sites are unchanged).

- [ ] **Step 1: Write the failing test** `tests/app/lineageCapture.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { SaveTranslation } from "../../src/app/SaveTranslation";
import { SaveRendering } from "../../src/app/SaveRendering";
import type { LineageStore, LineageSummary } from "../../src/ports/LineageStore";
import type { LineageEntry } from "../../src/domain/lineage/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";

function fakeLineage() {
  const appended: LineageEntry[] = [];
  const store: LineageStore = {
    append: async (e) => { appended.push(e); },
    load: async () => [],
    listItems: async (): Promise<LineageSummary[]> => [],
  };
  return { store, appended };
}
const noTranslationStore: TranslationStore = { loadAll: async () => [], upsert: async () => {}, listTranslatedIds: async () => new Set() };
const noFewShot: FewShotStore = { load: async () => [], add: async () => {} };
const fakeFormatting: FormattingStore = { loadAll: async () => [], upsert: async () => {}, listRenderedKeys: async () => new Set() };

describe("lineage capture", () => {
  it("SaveTranslation appends a translated entry with sourceText", async () => {
    const l = fakeLineage();
    await new SaveTranslation(noTranslationStore, noFewShot, () => "T", l.store).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(l.appended).toEqual([
      { itemId: "x:1", stage: "translated", content: "안녕", status: "translated", sourceText: "hi", at: "T" },
    ]);
  });

  it("SaveRendering appends a rendered entry keyed by type/channel", async () => {
    const l = fakeLineage();
    await new SaveRendering(fakeFormatting, () => "T", l.store).run({
      itemId: "x:1", type: "announcement", channel: "telegram", text: "본문",
    });
    expect(l.appended[0]).toMatchObject({ itemId: "x:1", stage: "rendered", variant: "announcement/telegram", status: "rendered", at: "T" });
  });

  it("a lineage append failure is swallowed — the save still succeeds", async () => {
    const throwing: LineageStore = { append: async () => { throw new Error("disk full"); }, load: async () => [], listItems: async () => [] };
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T", throwing).run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
  });

  it("no lineage store injected = no append, unchanged behavior", async () => {
    const res = await new SaveTranslation(noTranslationStore, noFewShot, () => "T").run({
      itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false,
    });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/lineageCapture.test.ts`
Expected: FAIL — `SaveTranslation`/`SaveRendering` don't accept a 4th/3rd arg / don't append.

- [ ] **Step 3: Implement** — add the optional arg + best-effort append to each use-case.

Shared shape of the append block (best-effort, never throws):
```ts
    if (this.lineage) {
      try {
        await this.lineage.append(/* entry */);
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
```

`SaveTranslation.ts` — add import `import type { LineageStore } from "../ports/LineageStore";`, add ctor arg `private readonly lineage?: LineageStore` after `now`, and after `await this.translationStore.upsert(translation);` insert the append with:
```ts
        await this.lineage.append({ itemId: input.itemId, stage: "translated", content: input.koreanText, status: translation.status, sourceText: input.sourceText, at: timestamp });
```

`SaveConversion.ts` — same pattern; ctor arg after `now`; after `await this.conversionStore.upsert(variant);`:
```ts
        await this.lineage.append({ itemId: input.itemId, stage: "converted", variant: input.type, content: input.convertedText, status: variant.status, at: timestamp });
```

`SaveRendering.ts` — ctor arg after `now`; after `await this.formattingStore.upsert(rendering);`:
```ts
        await this.lineage.append({ itemId: input.itemId, stage: "rendered", variant: `${input.type}/${input.channel}`, content: rendering.text, status: rendering.status, at: rendering.createdAt });
```
(Note: `rendering.createdAt` is `this.now()`; reuse it so the test's fixed `now` matches. `rendering.text` is the `toCanonical(input.text)` actually stored.)

`ApproveRendering.ts` — ctor arg after `now`; after `await this.formattingStore.upsert(approved);` (only when an existing rendering was found — the append is inside the found branch, before `return approved;`):
```ts
        await this.lineage.append({ itemId: input.itemId, stage: "rendered", variant: `${input.type}/${input.channel}`, content: approved.text, status: "approved", at: approved.approvedAt! });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/lineageCapture.test.ts`
Expected: PASS. Then run the existing use-case tests to confirm no regression: `pnpm exec vitest run tests/app`.

- [ ] **Step 5: Commit**

```bash
git add src/app/SaveTranslation.ts src/app/SaveConversion.ts src/app/SaveRendering.ts src/app/ApproveRendering.ts tests/app/lineageCapture.test.ts
git commit -m "feat(lineage): best-effort capture in the four save use-cases"
```

---

## Task 4: `pnpm lineage` CLI + always-on wiring + docs

**Files:**
- Create: `src/cli/lineage.ts`, `src/cli/lineage-wiring.ts`
- Modify: `src/cli/translate-save.ts`, `src/cli/convert-save.ts`, `src/cli/format-save.ts`, `src/cli/serve.ts`, `package.json`, `CHANGELOG.md`, `docs/ko/capabilities.md`

**Interfaces:**
- Consumes: `JsonlLineageStore`, `renderLineage`, `paths.lineageDir`, `argValue`.

- [ ] **Step 1: Implement the wiring helper** `src/cli/lineage-wiring.ts`

```ts
import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import type { LineageStore } from "../ports/LineageStore";
import { paths } from "../paths";

/** Always-on local lineage store (writes output/lineage/). */
export function buildLineage(): LineageStore {
  return new JsonlLineageStore(paths.lineageDir);
}
```

- [ ] **Step 2: Implement the CLI** `src/cli/lineage.ts`

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { JsonlLineageStore } from "../adapters/store/JsonlLineageStore";
import { renderLineage } from "../domain/lineage/render";
import { paths } from "../paths";

const store = new JsonlLineageStore(paths.lineageDir);
const itemId = process.argv[2]?.startsWith("--") ? argValue("--id") : process.argv[2];

if (!itemId) {
  const items = await store.listItems();
  if (items.length === 0) {
    console.log("no lineage yet (run the pipeline; output/lineage/ fills as items are saved)");
  } else {
    for (const s of items) console.log(`${s.itemId}\t${s.entries} entr(y/ies)\tlast: ${s.lastStage}`);
  }
} else {
  const entries = await store.load(itemId);
  if (entries.length === 0) console.log(`no lineage for ${itemId}`);
  else console.log(renderLineage(entries));
}
```

- [ ] **Step 3: Add the script** to `package.json` (next to `"status"`):

```json
"lineage": "tsx src/cli/lineage.ts",
```

- [ ] **Step 4: Wire `buildLineage()` into every save site.** Add `import { buildLineage } from "./lineage-wiring";` and pass it as the lineage arg (with `undefined` for `now`) at each instantiation:
  - `src/cli/translate-save.ts:36` → `new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir), undefined, buildLineage())`
  - `src/cli/convert-save.ts:39` → `new SaveConversion(conversionStore, fewShotByType, undefined, buildLineage())`
  - `src/cli/format-save.ts:40` → `new SaveRendering(formattingStore, undefined, buildLineage()).run(...)`
  - `src/cli/serve.ts` → `new SaveTranslation(..., undefined, buildLineage())`, `new SaveRendering(formattingStore, undefined, buildLineage())`, `new ApproveRendering(formattingStore, undefined, buildLineage())`, and the `SaveConversion` instantiation if serve has one (grep `new SaveConversion` / `new Save` in serve.ts and wire each).

  Grep to be exhaustive: `grep -rn 'new \(SaveTranslation\|SaveConversion\|SaveRendering\|ApproveRendering\)' src/cli src/adapters` and wire every hit.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Live smoke test**

Run: `pnpm translate:save --id x:2081711456320655644 --file /tmp/x.txt` after `printf '테스트 계보' > /tmp/x.txt` (or re-save an existing item). Then `pnpm lineage x:2081711456320655644`.
Expected: `output/lineage/x_2081711456320655644.jsonl` exists with a `translated` entry, and `pnpm lineage` prints the journey. Also run `pnpm lineage` (no id) → lists the item. (These writes land in git-ignored `output/lineage/`.)

- [ ] **Step 7: Docs**

- `CHANGELOG.md` `[Unreleased] → Added`: `pnpm lineage [itemId]` + the always-on per-item lineage (each save appends a stage snapshot to `output/lineage/<id>.jsonl`; the CLI shows the journey + per-revision diff). Reference `docs/superpowers/specs/2026-07-28-item-lineage-design.md`.
- `docs/ko/capabilities.md`: add `lineage` to the local-tools/inspection commands, noting it preserves each stage's output per item (translated/converted/rendered) and shows how an item changed. Match the file's tone; don't leave a neighbouring sentence stale.

- [ ] **Step 8: Full suite + commit**

```bash
pnpm test
git add src/cli/lineage.ts src/cli/lineage-wiring.ts src/cli/translate-save.ts src/cli/convert-save.ts src/cli/format-save.ts src/cli/serve.ts package.json CHANGELOG.md docs/ko/capabilities.md
git commit -m "feat(lineage): pnpm lineage CLI + always-on capture wiring + docs"
```

Expected: full suite green.

---

## Self-Review

**1. Spec coverage:** Decision 1 (append-only entry, stages translated/converted/rendered, source on translated, diff-at-view) → Task 1 model + Task 2 render + Task 3 appends. Decision 2 (best-effort capture in the 4 use-cases) → Task 3. Decision 3 (always-on, git-ignored, per-item JSONL, `:`→`_`) → Task 1 adapter + Task 4 wiring. Decision 4 (CLI + pure renderer) → Task 2 + Task 4. Error handling (best-effort, malformed-line skip, unknown id) → Task 1 (`load`/`listItems`), Task 3 (swallow), Task 4 CLI. Testing → Tasks 1-3. Every spec decision maps to a step.

**2. Placeholder scan:** No TBD/TODO; every code/test step is complete.

**3. Type consistency:** `LineageEntry`/`LineageStage` defined in Task 1, consumed by `LineageStore` (Task 1), `renderLineage` (Task 2), the use-cases (Task 3), and the CLI (Task 4). `LineageStore.{append,load,listItems}` used consistently (fake in Task 3 tests, real in Task 4). The optional `lineage?` ctor arg is added **after `now`** in all four use-cases, so `new Save*(store, …)` existing call sites and the `undefined`-for-now wiring in Task 4 both typecheck. `variant` format `type/channel` for renderings, `type` for conversions — consistent between Task 3 appends and Task 2's diff-keying.
