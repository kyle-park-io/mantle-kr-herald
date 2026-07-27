# TM Alignment Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `translate:align` step that revises a drafted-but-unapproved translation against its nearest-anchor EN↔KO precedent pairs, so the local agent conforms phrasing/terminology before 1차 검수.

**Architecture:** Hexagonal, mirroring `PrepareTranslations`. A pure domain selector (`selectPrecedents`) reuses PR #52's anchor engine; a pure worksheet assembler (`assembleAlignmentWorksheet`) formats draft + precedents; a `PrepareAlignment` use-case reads the `TranslationStore` and `tm.json`, selects per-draft precedents, and emits a worksheet string; a thin CLI wires stores, writes the worksheet, and prints counts. Writeback reuses the existing `translate:save` (it already falls back to an already-saved translation), so there is no new save command, port, or `pending.json`.

**Tech Stack:** ESM TypeScript, `vitest`, `tsx`, `zod`-only runtime dep, native `fetch` (none used here — pure local file work).

## Global Constraints

- Runtime deps stay **zod-only**; add no dependency; make no network call.
- Reuse PR #52's anchor engine (`extractAnchors`/`sharedAnchors` in `src/domain/tm/anchors.ts`) — do not reimplement anchor logic.
- The human gate is **1차 검수**; a saved alignment stays `status: "translated"` (never auto-approved).
- Selector semantics match `PrepareTranslations`: `--ids` exact match, `--since` on the stored timestamp (`translatedAt`), `--limit` default 20. Reuse the exported `Selector` type from `src/app/PrepareTranslations.ts`.
- `K = 3` precedents per draft (constant). A draft with **zero** shared-anchor precedents is excluded from the worksheet and counted as skipped.
- Worksheet context is **slim**: draft + its precedents only — no glossary, no style guide.
- The "agent" is local Claude filling a worksheet (like `translate:prepare`) — **no Claude API**.
- Public repo: synthetic data only in tests — no steering content, no real post text, no PII.
- Every test must be able to fail: pin concrete anchors/text/counts, never an assertion a mutation would still satisfy.

---

## File Structure

- **Modify** `src/domain/tm/selection.ts` — extract a shared `selectByAnchors(targetAnchors, tm, k)` core; re-express `selectRelevantTm` through it (behavior unchanged); add `selectPrecedents(sourceText, tm, k)`.
- **Create** `src/domain/translation/alignmentWorksheet.ts` — `AlignmentBlock` type + `assembleAlignmentWorksheet(blocks)`.
- **Create** `src/app/PrepareAlignment.ts` — the use-case.
- **Create** `src/cli/translate-align.ts` — the CLI entrypoint.
- **Modify** `package.json` — add the `translate:align` script.
- **Modify** `CHANGELOG.md`, `docs/ko/capabilities.md`, `docs/ko/team-runbook.md` — document the new step.
- **Tests:** extend `tests/domain/tm/selection.test.ts`; create `tests/domain/translation/alignmentWorksheet.test.ts`; create `tests/app/prepareAlignment.test.ts`.

---

## Task 1: `selectPrecedents` — per-draft anchor ranking (domain)

**Files:**
- Modify: `src/domain/tm/selection.ts`
- Test: `tests/domain/tm/selection.test.ts` (extend; keep the existing `selectRelevantTm` cases green)

**Interfaces:**
- Consumes: `extractAnchors`, `sharedAnchors` from `./anchors`; `FewShotExample` from `../translation/models`.
- Produces: `selectPrecedents(sourceText: string, tm: FewShotExample[], k: number): FewShotExample[]` — top-K TM pairs by shared-anchor count between `sourceText` and each pair's `source`, `> 0` only, equal scores keep input order.

- [ ] **Step 1: Write the failing tests** (append to `tests/domain/tm/selection.test.ts`)

```ts
import { selectPrecedents } from "../../../src/domain/tm/selection";
import type { FewShotExample } from "../../../src/domain/translation/models";

const pair = (source: string, target: string): FewShotExample => ({ source, target });

describe("selectPrecedents", () => {
  it("ranks precedents by shared-anchor count with the draft source, highest first", () => {
    const tm = [
      pair("gm $MNT and $BTC", "안녕 $MNT $BTC"), // 2 shared
      pair("just $MNT today", "오늘 $MNT"), // 1 shared
      pair("unrelated $ETH", "관련없음 $ETH"), // 0 shared
    ];
    const got = selectPrecedents("$MNT $BTC update", tm, 3);
    expect(got.map((p) => p.source)).toEqual(["gm $MNT and $BTC", "just $MNT today"]);
  });

  it("excludes zero-overlap precedents and caps at k", () => {
    const tm = [pair("$MNT a", "가"), pair("$MNT b", "나"), pair("$MNT c", "다"), pair("$ETH d", "라")];
    const got = selectPrecedents("$MNT", tm, 2);
    expect(got).toHaveLength(2);
    expect(got.every((p) => p.source.includes("$MNT"))).toBe(true);
  });

  it("returns nothing when the draft has no anchors", () => {
    expect(selectPrecedents("plain text no anchors", [pair("$MNT x", "y")], 3)).toEqual([]);
  });
});
```

Note: match the existing file's import style — if it already imports `describe/it/expect` and `selectRelevantTm`, add only the new `selectPrecedents`/`FewShotExample`/`pair` imports and the new `describe` block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/domain/tm/selection.test.ts`
Expected: FAIL — `selectPrecedents` is not exported.

- [ ] **Step 3: Refactor + implement** in `src/domain/tm/selection.ts`

```ts
import type { ContentItem } from "../translation/contentItem";
import type { FewShotExample } from "../translation/models";
import { extractAnchors, sharedAnchors } from "./anchors";

function selectByAnchors(targetAnchors: string[], tm: FewShotExample[], k: number): FewShotExample[] {
  return tm
    .map((ex) => ({ ex, score: sharedAnchors(extractAnchors(ex.source), targetAnchors).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k)
    .map((s) => s.ex);
}

export function selectRelevantTm(batch: ContentItem[], tm: FewShotExample[], k: number): FewShotExample[] {
  const batchAnchors = [...new Set(batch.flatMap((i) => extractAnchors(i.text)))];
  return selectByAnchors(batchAnchors, tm, k);
}

export function selectPrecedents(sourceText: string, tm: FewShotExample[], k: number): FewShotExample[] {
  return selectByAnchors(extractAnchors(sourceText), tm, k);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/tm/selection.test.ts`
Expected: PASS — both the new `selectPrecedents` cases and the pre-existing `selectRelevantTm` cases (the refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/selection.ts tests/domain/tm/selection.test.ts
git commit -m "feat(tm): selectPrecedents — per-draft nearest-anchor precedent selection"
```

---

## Task 2: `assembleAlignmentWorksheet` — the worksheet formatter (domain)

**Files:**
- Create: `src/domain/translation/alignmentWorksheet.ts`
- Test: `tests/domain/translation/alignmentWorksheet.test.ts`

**Interfaces:**
- Consumes: `FewShotExample` from `./models`.
- Produces: `interface AlignmentBlock { itemId: string; sourceText: string; draftKorean: string; precedents: FewShotExample[] }` and `assembleAlignmentWorksheet(blocks: AlignmentBlock[]): string`.

- [ ] **Step 1: Write the failing test** (`tests/domain/translation/alignmentWorksheet.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { assembleAlignmentWorksheet, type AlignmentBlock } from "../../../src/domain/translation/alignmentWorksheet";

const block = (over: Partial<AlignmentBlock> = {}): AlignmentBlock => ({
  itemId: "x:1",
  sourceText: "gm $MNT",
  draftKorean: "지엠 $MNT",
  precedents: [{ source: "gm $MNT fam", target: "안녕 $MNT 여러분" }],
  ...over,
});

describe("assembleAlignmentWorksheet", () => {
  it("renders 원문, 현재 번역, and 선례 pairs for a block", () => {
    const ws = assembleAlignmentWorksheet([block()]);
    expect(ws).toContain("### x:1");
    expect(ws).toContain("원문:\ngm $MNT");
    expect(ws).toContain("현재 번역:\n지엠 $MNT");
    expect(ws).toContain("- EN: gm $MNT fam\n  KO: 안녕 $MNT 여러분");
    expect(ws).toContain("번역:");
  });

  it("handles an empty block list — header only, no item sections", () => {
    const ws = assembleAlignmentWorksheet([]);
    expect(ws).toContain("정렬");
    expect(ws).not.toContain("###");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/translation/alignmentWorksheet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/domain/translation/alignmentWorksheet.ts`

```ts
import type { FewShotExample } from "./models";

export interface AlignmentBlock {
  itemId: string;
  sourceText: string;
  draftKorean: string;
  precedents: FewShotExample[];
}

function renderBlock(b: AlignmentBlock): string {
  const precedents = b.precedents.map((p) => `- EN: ${p.source}\n  KO: ${p.target}`).join("\n");
  return [`### ${b.itemId}`, "원문:", b.sourceText, "현재 번역:", b.draftKorean, "선례:", precedents, "번역:", ""].join("\n");
}

export function assembleAlignmentWorksheet(blocks: AlignmentBlock[]): string {
  const header = [
    "# Mantle KR 번역 정렬 (TM alignment)",
    "",
    "아래 각 아이템의 `현재 번역:`을, `선례:`의 EN↔KO 쌍에서 쓰인 표현·용어에 맞게 다듬어 `번역:` 아래에 채워 주세요.",
    "선례가 다루지 않는 부분은 그대로 두고, `---` 스레드 구분자·캐시태그/해시태그/멘션·링크는 보존하세요.",
    "재번역이 아니라 선례에 맞춘 교정입니다.",
    "",
    "---",
    "",
  ].join("\n");
  return header + blocks.map(renderBlock).join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/domain/translation/alignmentWorksheet.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/translation/alignmentWorksheet.ts tests/domain/translation/alignmentWorksheet.test.ts
git commit -m "feat(tm): alignment worksheet assembler (draft + precedents)"
```

---

## Task 3: `PrepareAlignment` use-case (app)

**Files:**
- Create: `src/app/PrepareAlignment.ts`
- Test: `tests/app/prepareAlignment.test.ts`

**Interfaces:**
- Consumes: `TranslationStore` (`loadAll`), `FewShotStore` (`load`); `selectPrecedents` (Task 1); `assembleAlignmentWorksheet`/`AlignmentBlock` (Task 2); `Selector` from `./PrepareTranslations`; `Translation` from `../domain/translation/models`.
- Produces: `class PrepareAlignment` with `run(selector: Selector): Promise<{ worksheet: string; aligned: number; skipped: number }>`.

- [ ] **Step 1: Write the failing test** (`tests/app/prepareAlignment.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { PrepareAlignment } from "../../src/app/PrepareAlignment";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { Translation, FewShotExample } from "../../src/domain/translation/models";

function translation(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "gm $MNT", koreanText: "지엠", status: "translated", translatedAt: "2026-07-20T00:00:00.000Z", ...over };
}

function stores(translations: Translation[], tm: FewShotExample[]) {
  const translationStore: TranslationStore = {
    loadAll: async () => translations,
    upsert: async () => {},
    listTranslatedIds: async () => new Set(),
  };
  const tmStore: FewShotStore = { load: async () => tm, add: async () => {} };
  return { translationStore, tmStore };
}

describe("PrepareAlignment", () => {
  it("aligns only translated drafts that have a precedent; skips precedentless, excludes approved", async () => {
    const s = stores(
      [
        translation({ itemId: "x:1", sourceText: "gm $MNT", status: "translated" }), // precedent → aligned
        translation({ itemId: "x:2", sourceText: "no anchors here", status: "translated" }), // no precedent → skip
        translation({ itemId: "x:3", sourceText: "gm $MNT", status: "approved" }), // approved → excluded entirely
      ],
      [{ source: "gm $MNT fam", target: "안녕" }],
    );
    const res = await new PrepareAlignment(s.translationStore, s.tmStore).run({});
    expect(res.aligned).toBe(1);
    expect(res.skipped).toBe(1); // x:2 only — x:3 is filtered before the precedent lookup
    expect(res.worksheet).toContain("### x:1");
    expect(res.worksheet).not.toContain("### x:2");
    expect(res.worksheet).not.toContain("### x:3");
  });

  it("filters by --ids", async () => {
    const s = stores(
      [translation({ itemId: "x:1" }), translation({ itemId: "x:2" })],
      [{ source: "gm $MNT fam", target: "안녕" }],
    );
    const res = await new PrepareAlignment(s.translationStore, s.tmStore).run({ ids: ["x:2"] });
    expect(res.aligned).toBe(1);
    expect(res.worksheet).toContain("### x:2");
    expect(res.worksheet).not.toContain("### x:1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/prepareAlignment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/app/PrepareAlignment.ts`

```ts
import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { Translation } from "../domain/translation/models";
import type { Selector } from "./PrepareTranslations";
import { selectPrecedents } from "../domain/tm/selection";
import { assembleAlignmentWorksheet, type AlignmentBlock } from "../domain/translation/alignmentWorksheet";

const DEFAULT_LIMIT = 20;
const PRECEDENTS_PER_DRAFT = 3;

export interface PrepareAlignmentResult {
  worksheet: string;
  aligned: number;
  skipped: number;
}

export class PrepareAlignment {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly tmStore: FewShotStore,
  ) {}

  async run(selector: Selector): Promise<PrepareAlignmentResult> {
    const drafts = this.applySelector(
      (await this.translationStore.loadAll()).filter((t) => t.status === "translated"),
      selector,
    );
    const tm = await this.tmStore.load();

    const blocks: AlignmentBlock[] = [];
    let skipped = 0;
    for (const d of drafts) {
      const precedents = selectPrecedents(d.sourceText, tm, PRECEDENTS_PER_DRAFT);
      if (precedents.length === 0) {
        skipped += 1;
        continue;
      }
      blocks.push({ itemId: d.itemId, sourceText: d.sourceText, draftKorean: d.koreanText, precedents });
    }

    return { worksheet: assembleAlignmentWorksheet(blocks), aligned: blocks.length, skipped };
  }

  private applySelector(drafts: Translation[], selector: Selector): Translation[] {
    let result = drafts;
    if (selector.ids && selector.ids.length > 0) {
      const wanted = new Set(selector.ids);
      result = result.filter((t) => wanted.has(t.itemId));
    }
    if (selector.since) {
      const since = selector.since;
      result = result.filter((t) => t.translatedAt >= since);
    }
    const limit = selector.limit ?? DEFAULT_LIMIT;
    return result.slice(0, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/app/prepareAlignment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/PrepareAlignment.ts tests/app/prepareAlignment.test.ts
git commit -m "feat(tm): PrepareAlignment — select per-draft precedents, emit align worksheet"
```

---

## Task 4: `translate:align` CLI + docs

**Files:**
- Create: `src/cli/translate-align.ts`
- Modify: `package.json` (script), `CHANGELOG.md`, `docs/ko/capabilities.md`, `docs/ko/team-runbook.md`

**Interfaces:**
- Consumes: `PrepareAlignment` (Task 3); `Selector` from `../app/PrepareTranslations`; `JsonTranslationStore`, `JsonFewShotStore`, `paths`, `argValue`.
- Produces: the `translate:align` command.

- [ ] **Step 1: Implement the CLI** `src/cli/translate-align.ts`

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { PrepareAlignment } from "../app/PrepareAlignment";
import type { Selector } from "../app/PrepareTranslations";
import { paths } from "../paths";

const selector: Selector = {};
const ids = argValue("--ids");
if (ids) selector.ids = ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const since = argValue("--since");
if (since) selector.since = since;
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (Number.isFinite(n)) selector.limit = n;
}

const usecase = new PrepareAlignment(
  new JsonTranslationStore(paths.translationsDir),
  new JsonFewShotStore(paths.translationConfigDir, "tm.json"),
);

const { worksheet, aligned, skipped } = await usecase.run(selector);

if (aligned === 0) {
  console.log(`nothing to align · skipped ${skipped} (no precedent)`);
} else {
  await mkdir(paths.translationsWorksheets, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worksheetPath = join(paths.translationsWorksheets, `align-${stamp}.md`);
  await writeFile(worksheetPath, worksheet, "utf8");
  console.log(`aligned ${aligned} · skipped ${skipped} (no precedent) → ${worksheetPath}`);
  console.log("Revise each item's 현재 번역 into the 번역 section, then: pnpm translate:save --id <id> --file <korean.txt>");
}
```

- [ ] **Step 2: Add the script** to `package.json` (next to `translate:prepare`/`translate:save`)

```json
"translate:align": "tsx --env-file-if-exists=.env src/cli/translate-align.ts",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Live smoke test** against the real stores (there are drafted translations in `output/` and one pair in `translation/tm.json`)

Run: `pnpm translate:align`
Expected: prints either `aligned N · skipped M (no precedent) → …/align-<stamp>.md` (and the file exists and contains `### <id>` + `선례:`), or `nothing to align · skipped M (no precedent)` if no draft shares an anchor with the single promoted pair. Either outcome proves the wiring; open the worksheet if one was written and confirm it reads as a correction task, not a re-translation. Delete the smoke-test worksheet afterward (it is git-ignored under `output/`).

- [ ] **Step 5: Update docs**

- `CHANGELOG.md` `[Unreleased] → Added`: a bullet for `pnpm translate:align` (optional pass; drafts + nearest-anchor precedents → agent revises → `translate:save`; 1차 검수 stays the gate; anchor-only, lexical fallback deferred). Reference `docs/superpowers/specs/2026-07-28-tm-alignment-pass-design.md`.
- `docs/ko/capabilities.md`: add `translate:align` to the translation-stage commands, noting it is optional and sits between `translate:save` and 1차 검수.
- `docs/ko/team-runbook.md`: in the translation flow, add the optional align step (`pnpm translate:align` → revise in the worksheet → `pnpm translate:save --id … --file …`).

Match each doc's existing tone/structure; keep the companion-update rule (do not let a neighbouring sentence go stale).

- [ ] **Step 6: Full suite + commit**

```bash
pnpm test
git add src/cli/translate-align.ts package.json CHANGELOG.md docs/ko/capabilities.md docs/ko/team-runbook.md
git commit -m "feat(tm): translate:align CLI + docs — optional TM alignment pass"
```

Expected: full suite green.

---

## Self-Review

**1. Spec coverage:** Decision 1 (optional `translate:align` on translated drafts, writeback via existing `translate:save`) → Task 4 CLI + Task 3 selection of `status==="translated"`. Decision 2 (anchor per-draft, K=3, skip on none) → Task 1 `selectPrecedents` + Task 3 `PRECEDENTS_PER_DRAFT`/skip. Decision 3 (slim worksheet: 원문/현재 번역/선례) → Task 2 assembler. Decision 4 (`PrepareAlignment`, no new port/pending) → Task 3. Data flow, error handling (nothing-to-align / no-precedent), and testing all map to tasks. No spec requirement is unaddressed.

**2. Placeholder scan:** No TBD/TODO; every code and test step contains complete content.

**3. Type consistency:** `selectPrecedents(sourceText, tm, k)` defined in Task 1, consumed in Task 3. `AlignmentBlock { itemId, sourceText, draftKorean, precedents }` defined in Task 2, constructed in Task 3. `PrepareAlignment.run(selector)` returns `{ worksheet, aligned, skipped }`, consumed by the CLI in Task 4. `Selector` imported from `PrepareTranslations` in Tasks 3 and 4. `Translation`/`FewShotExample`/`TranslationStore`/`FewShotStore` used with their real shapes (`loadAll`, `load`, `status`, `sourceText`, `koreanText`, `translatedAt`). Consistent throughout.
