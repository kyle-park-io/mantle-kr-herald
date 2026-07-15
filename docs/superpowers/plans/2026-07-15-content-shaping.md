# Content Shaping (§5 Conversion + §6 Formatting) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an approved Korean translation into item-type variants (X / KOL / PR) and then into channel-formatted text (X / Telegram / KakaoTalk / PR-mail).

**Architecture:** Hexagonal, mirroring the §3 translation flow. §5 (conversion) is agent-assisted: a worksheet is assembled from steering config, the local agent fills it, `convert:save` ingests it and (on `--approve`) feeds a per-type few-shot flywheel. §6 (formatting) is deterministic pure-function code (`formatForChannel`) with an optional agent refinement pass. New domain lives in `src/domain/conversion/` and `src/domain/formatting/`; new ports/adapters/use-cases/CLIs follow existing names.

**Tech Stack:** TypeScript ESM (`moduleResolution: bundler`, no `.js` import suffixes), tsx, vitest, zod-only runtime dep, `node:fs`/`node:path`/`node:crypto`.

## Global Constraints

- Code and comments in English; user-facing worksheet copy may be Korean (matches `translation/` config).
- Runtime dependencies stay **zod-only**; no new packages.
- ESM imports have **no file extension** (`moduleResolution: bundler`).
- JSON persistence uses the existing helpers `readJsonFile` / `writeJsonFileAtomic` from `src/shared/store/jsonFile.ts` (atomic temp-file + rename).
- Reuse the existing `translation/glossary.json` (via `JsonGlossaryStore`) and `translation/locale.json` (via `FileTranslationConfig`) — do NOT duplicate terminology/locale config.
- Types are the fixed set `["x", "kol", "pr"]`; channels the fixed set `["x", "telegram", "kakao", "pr_mail"]`.
- Every CLI is registered as a `pnpm` script and run with `tsx` (no `--env-file` needed — these commands touch only local files).

---

## File Structure

**§5 conversion**
- `src/domain/conversion/models.ts` — `ConversionType`, `ALL_TYPES`, `ContentVariant`, `typeLabel`.
- `src/domain/conversion/promptAssembler.ts` — worksheet assembly (`assembleTypeSection`, `assembleConversionWorksheet`, `assembleVariantBlock`).
- `src/ports/ConversionStore.ts` — variant persistence port.
- `src/ports/ConversionConfig.ts` — per-type guide port.
- `src/adapters/store/JsonConversionStore.ts` — `output/variants/variants.json`.
- `src/adapters/store/FileConversionConfig.ts` — reads `conversion/<type>.md`.
- `src/adapters/store/JsonTypedFewShotStore.ts` — `conversion/few-shot.<type>.json` (implements existing `FewShotStore`).
- `src/app/PrepareConversions.ts`, `src/app/SaveConversion.ts` — use-cases.
- `src/cli/convert-prepare.ts`, `src/cli/convert-save.ts` — CLIs.
- `conversion/x.md`, `conversion/kol.md`, `conversion/pr.md`, `conversion/few-shot.{x,kol,pr}.json` — seed config (git-tracked).

**§6 formatting**
- `src/domain/formatting/models.ts` — `Channel`, `ChannelRendering`, `FormatOptions`, `FormatResult`, `DEFAULT_CHANNELS_BY_TYPE`.
- `src/domain/formatting/channelFormat.ts` — `formatForChannel` + markdown helpers.
- `src/domain/formatting/refinementWorksheet.ts` — `assembleRefinementWorksheet`.
- `src/ports/FormattingStore.ts` — rendering persistence port.
- `src/adapters/store/JsonFormattingStore.ts` — `output/formatted/renderings.json`.
- `src/app/FormatVariants.ts`, `src/app/PrepareRefinements.ts`, `src/app/SaveRendering.ts` — use-cases.
- `src/cli/format.ts`, `src/cli/format-save.ts` — CLIs.

---

## Task 1: §5 domain — models + prompt assembler

**Files:**
- Create: `src/domain/conversion/models.ts`
- Create: `src/domain/conversion/promptAssembler.ts`
- Modify: `src/domain/translation/promptAssembler.ts` (export two render helpers for reuse)
- Test: `tests/domain/conversion/promptAssembler.test.ts`

**Interfaces:**
- Consumes: `GlossaryEntry`, `Locale`, `FewShotExample` from `src/domain/translation/models.ts`.
- Produces:
  - `type ConversionType = "x" | "kol" | "pr"`
  - `const ALL_TYPES: ConversionType[]`
  - `interface ContentVariant { itemId: string; type: ConversionType; sourceKorean: string; convertedText: string; status: "converted" | "approved"; createdAt: string; approvedAt?: string }`
  - `function typeLabel(type: ConversionType): string`
  - `function assembleVariantBlock(itemId: string, sourceKorean: string): string`
  - `function assembleTypeSection(input: { type: ConversionType; guideText: string; glossary: GlossaryEntry[]; locale: Locale; fewShots: FewShotExample[]; items: { itemId: string; sourceKorean: string }[] }): string`
  - `function assembleConversionWorksheet(sections: string[]): string`

- [ ] **Step 1: Export the two render helpers from the translation assembler**

In `src/domain/translation/promptAssembler.ts`, add `export` to the two existing private functions so they can be reused (keeps glossary/locale rendering DRY):

```ts
export function renderGlossaryEntry(e: GlossaryEntry): string {
```
```ts
export function renderLocale(l: Locale): string {
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/domain/conversion/promptAssembler.test.ts
import { describe, it, expect } from "vitest";
import {
  assembleVariantBlock,
  assembleTypeSection,
  assembleConversionWorksheet,
  typeLabel,
} from "../../../src/domain/conversion/promptAssembler";
import type { GlossaryEntry, Locale, FewShotExample } from "../../../src/domain/translation/models";

const locale: Locale = {
  dateFormat: "YYYY년 M월 D일", numberFormat: "천 단위 콤마",
  currency: "USD", unit: "미터법", honorific: "합니다체",
};
const glossary: GlossaryEntry[] = [{ term: "Mainnet", rule: "transliterate", target: "메인넷", updatedAt: "2026-01-01" }];
const fewShots: FewShotExample[] = [{ source: "승인된 한글", target: "변환된 카피", itemId: "x:1" }];

describe("typeLabel", () => {
  it("maps types to display labels", () => {
    expect(typeLabel("x")).toBe("X");
    expect(typeLabel("kol")).toBe("KOL");
    expect(typeLabel("pr")).toBe("PR");
  });
});

describe("assembleVariantBlock", () => {
  it("emits the id, 승인본 with the Korean, and an empty 변환 slot", () => {
    const out = assembleVariantBlock("x:100", "안녕 맨틀");
    expect(out).toContain("### x:100");
    expect(out).toContain("승인본:");
    expect(out).toContain("안녕 맨틀");
    expect(out.trimEnd().endsWith("변환:")).toBe(true);
  });
});

describe("assembleTypeSection", () => {
  it("includes the type label, guide, glossary, locale, few-shots, and every item block", () => {
    const out = assembleTypeSection({
      type: "x", guideText: "X 유형 역할·스타일", glossary, locale, fewShots,
      items: [{ itemId: "x:1", sourceKorean: "원문 카피" }, { itemId: "x:2", sourceKorean: "다른 카피" }],
    });
    expect(out).toContain("## 유형: X");
    expect(out).toContain("X 유형 역할·스타일");
    expect(out).toContain("Mainnet → transliterate: 메인넷");
    expect(out).toContain("합니다체");
    expect(out).toContain("승인된 한글");   // few-shot source
    expect(out).toContain("변환된 카피");   // few-shot target
    expect(out).toContain("### x:1");
    expect(out).toContain("### x:2");
  });
});

describe("assembleConversionWorksheet", () => {
  it("prefixes a header and joins sections", () => {
    const out = assembleConversionWorksheet(["## 유형: X\n...", "## 유형: KOL\n..."]);
    expect(out).toContain("아이템 변환");
    expect(out.indexOf("유형: X")).toBeLessThan(out.indexOf("유형: KOL"));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/conversion/promptAssembler.test.ts`
Expected: FAIL — module `src/domain/conversion/promptAssembler` not found.

- [ ] **Step 4: Create the models**

```ts
// src/domain/conversion/models.ts
export type ConversionType = "x" | "kol" | "pr";

export const ALL_TYPES: ConversionType[] = ["x", "kol", "pr"];

/** One approved translation rewritten for a target item type. Identity is (itemId, type). */
export interface ContentVariant {
  itemId: string; // "x:<rootId>" | "lark:<messageId>" — same id as the translation
  type: ConversionType;
  sourceKorean: string; // the approved translation (input, kept for provenance)
  convertedText: string; // agent-produced, type-specific Korean copy
  status: "converted" | "approved";
  createdAt: string; // ISO
  approvedAt?: string;
}

const LABELS: Record<ConversionType, string> = { x: "X", kol: "KOL", pr: "PR" };
export function typeLabel(type: ConversionType): string {
  return LABELS[type];
}
```

- [ ] **Step 5: Create the prompt assembler**

```ts
// src/domain/conversion/promptAssembler.ts
import type { GlossaryEntry, Locale, FewShotExample } from "../translation/models";
import { renderGlossaryEntry, renderLocale } from "../translation/promptAssembler";
import { typeLabel, type ConversionType } from "./models";

/** Per-item block: approved Korean in, empty 변환 slot out. No shared context here. */
export function assembleVariantBlock(itemId: string, sourceKorean: string): string {
  return [`### ${itemId}`, "승인본:", sourceKorean, "변환:", ""].join("\n");
}

export interface TypeSectionInput {
  type: ConversionType;
  guideText: string;
  glossary: GlossaryEntry[];
  locale: Locale;
  fewShots: FewShotExample[];
  items: { itemId: string; sourceKorean: string }[];
}

/** One type's full section: role/style + glossary + locale + few-shots, then item blocks. */
export function assembleTypeSection(input: TypeSectionInput): string {
  const label = typeLabel(input.type);
  const glossary = input.glossary.map(renderGlossaryEntry).join("\n");
  const fewShots = input.fewShots.map((f) => `- 원문: ${f.source}\n  변환: ${f.target}`).join("\n");
  const blocks = input.items.map((i) => assembleVariantBlock(i.itemId, i.sourceKorean));
  return [
    `## 유형: ${label}`,
    "",
    "### 역할·스타일",
    input.guideText,
    "",
    "### 용어집 (Glossary)",
    glossary,
    "",
    "### 로케일",
    renderLocale(input.locale),
    "",
    "### 예시 (Few-shot)",
    fewShots,
    "",
    "---",
    `아래 각 아이템의 \`승인본:\`을 위 규칙에 따라 ${label} 유형에 맞게 변환해 \`변환:\` 아래에 채워 주세요.`,
    "",
    ...blocks,
  ].join("\n");
}

export function assembleConversionWorksheet(sections: string[]): string {
  return ["# Mantle KR 아이템 변환 작업", "", ...sections].join("\n");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/conversion/promptAssembler.test.ts`
Expected: PASS (4 describe blocks).

- [ ] **Step 7: Typecheck & commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/domain/conversion tests/domain/conversion src/domain/translation/promptAssembler.ts
git commit -m "feat: conversion domain models + worksheet prompt assembler (§5)"
```

---

## Task 2: §5 `ConversionStore` port + `JsonConversionStore`

**Files:**
- Create: `src/ports/ConversionStore.ts`
- Create: `src/adapters/store/JsonConversionStore.ts`
- Test: `tests/adapters/store/JsonConversionStore.test.ts`

**Interfaces:**
- Consumes: `ContentVariant` from `src/domain/conversion/models.ts`; `readJsonFile`/`writeJsonFileAtomic` from `src/shared/store/jsonFile.ts`.
- Produces:
  - `interface ConversionStore { loadAll(): Promise<ContentVariant[]>; upsert(v: ContentVariant): Promise<void>; listConvertedKeys(): Promise<Set<string>> }`
  - `class JsonConversionStore implements ConversionStore` (constructor `(dir: string)`, file `variants.json`, key `` `${itemId}:${type}` ``)

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/store/JsonConversionStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonConversionStore } from "../../../src/adapters/store/JsonConversionStore";
import type { ContentVariant } from "../../../src/domain/conversion/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피",
    status: "converted", createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "conv-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonConversionStore", () => {
  it("returns [] when the file is missing", async () => {
    expect(await new JsonConversionStore(dir).loadAll()).toEqual([]);
  });

  it("upserts by (itemId, type): same key replaces, different type coexists", async () => {
    const store = new JsonConversionStore(dir);
    await store.upsert(variant({ convertedText: "v1" }));
    await store.upsert(variant({ convertedText: "v2" }));          // same (x:1, x) → replace
    await store.upsert(variant({ type: "kol", convertedText: "k" })); // (x:1, kol) → new
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((v) => v.type === "x")?.convertedText).toBe("v2");
    expect(all.find((v) => v.type === "kol")?.convertedText).toBe("k");
  });

  it("listConvertedKeys returns `${itemId}:${type}` keys", async () => {
    const store = new JsonConversionStore(dir);
    await store.upsert(variant());
    await store.upsert(variant({ itemId: "x:2", type: "pr" }));
    expect(await store.listConvertedKeys()).toEqual(new Set(["x:1:x", "x:2:pr"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/store/JsonConversionStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the port**

```ts
// src/ports/ConversionStore.ts
import type { ContentVariant } from "../domain/conversion/models";

export interface ConversionStore {
  loadAll(): Promise<ContentVariant[]>;
  upsert(v: ContentVariant): Promise<void>; // by (itemId, type)
  listConvertedKeys(): Promise<Set<string>>; // `${itemId}:${type}`
}
```

- [ ] **Step 4: Create the adapter**

```ts
// src/adapters/store/JsonConversionStore.ts
import { join } from "node:path";
import type { ContentVariant } from "../../domain/conversion/models";
import type { ConversionStore } from "../../ports/ConversionStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

const key = (v: Pick<ContentVariant, "itemId" | "type">) => `${v.itemId}:${v.type}`;

export class JsonConversionStore implements ConversionStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "variants.json");
  }
  async loadAll(): Promise<ContentVariant[]> {
    return readJsonFile<ContentVariant[]>(this.path, []);
  }
  async upsert(v: ContentVariant): Promise<void> {
    const all = await this.loadAll();
    const byKey = new Map(all.map((x) => [key(x), x]));
    byKey.set(key(v), v);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async listConvertedKeys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map(key));
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/store/JsonConversionStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/ConversionStore.ts src/adapters/store/JsonConversionStore.ts tests/adapters/store/JsonConversionStore.test.ts
git commit -m "feat: ConversionStore port + JsonConversionStore (§5)"
```

---

## Task 3: §5 `ConversionConfig` + `FileConversionConfig` + `JsonTypedFewShotStore` + seed config

**Files:**
- Create: `src/ports/ConversionConfig.ts`
- Create: `src/adapters/store/FileConversionConfig.ts`
- Create: `src/adapters/store/JsonTypedFewShotStore.ts`
- Create: `conversion/x.md`, `conversion/kol.md`, `conversion/pr.md`
- Create: `conversion/few-shot.x.json`, `conversion/few-shot.kol.json`, `conversion/few-shot.pr.json`
- Test: `tests/adapters/store/FileConversionConfig.test.ts`

**Interfaces:**
- Consumes: `ConversionType` from `src/domain/conversion/models.ts`; `FewShotStore` port + `FewShotExample` model; `readJsonFile`/`writeJsonFileAtomic`.
- Produces:
  - `interface ConversionConfig { loadTypeGuide(type: ConversionType): Promise<{ text: string }> }`
  - `class FileConversionConfig implements ConversionConfig` (constructor `(dir: string)`, reads `<type>.md`, ENOENT → `{ text: "" }`)
  - `class JsonTypedFewShotStore implements FewShotStore` (constructor `(dir: string, type: ConversionType)`, file `few-shot.<type>.json`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/store/FileConversionConfig.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversionConfig } from "../../../src/adapters/store/FileConversionConfig";
import { JsonTypedFewShotStore } from "../../../src/adapters/store/JsonTypedFewShotStore";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "conv-cfg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("FileConversionConfig", () => {
  it("reads conversion/<type>.md", async () => {
    await writeFile(join(dir, "x.md"), "X 유형 지침", "utf8");
    expect(await new FileConversionConfig(dir).loadTypeGuide("x")).toEqual({ text: "X 유형 지침" });
  });
  it("returns empty text when the guide file is missing", async () => {
    expect(await new FileConversionConfig(dir).loadTypeGuide("pr")).toEqual({ text: "" });
  });
});

describe("JsonTypedFewShotStore", () => {
  it("reads/writes few-shot.<type>.json and upserts by itemId", async () => {
    const store = new JsonTypedFewShotStore(dir, "kol");
    expect(await store.load()).toEqual([]);
    await store.add({ source: "a", target: "b", itemId: "x:1" });
    await store.add({ source: "a2", target: "b2", itemId: "x:1" }); // replace
    await store.add({ source: "c", target: "d", itemId: "x:2" });
    const all = await store.load();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.itemId === "x:1")?.target).toBe("b2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/store/FileConversionConfig.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create the port**

```ts
// src/ports/ConversionConfig.ts
import type { ConversionType } from "../domain/conversion/models";

export interface ConversionConfig {
  loadTypeGuide(type: ConversionType): Promise<{ text: string }>;
}
```

- [ ] **Step 4: Create `FileConversionConfig`**

```ts
// src/adapters/store/FileConversionConfig.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversionType } from "../../domain/conversion/models";
import type { ConversionConfig } from "../../ports/ConversionConfig";

export class FileConversionConfig implements ConversionConfig {
  constructor(private readonly dir: string) {}

  async loadTypeGuide(type: ConversionType): Promise<{ text: string }> {
    try {
      return { text: await readFile(join(this.dir, `${type}.md`), "utf8") };
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "" };
      }
      throw err;
    }
  }
}
```

- [ ] **Step 5: Create `JsonTypedFewShotStore`**

```ts
// src/adapters/store/JsonTypedFewShotStore.ts
import { join } from "node:path";
import type { ConversionType } from "../../domain/conversion/models";
import type { FewShotExample } from "../../domain/translation/models";
import type { FewShotStore } from "../../ports/FewShotStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

/** Per-type few-shot store: `few-shot.<type>.json`. Same upsert-by-itemId semantics as JsonFewShotStore. */
export class JsonTypedFewShotStore implements FewShotStore {
  private readonly path: string;
  constructor(private readonly dir: string, type: ConversionType) {
    this.path = join(dir, `few-shot.${type}.json`);
  }
  async load(): Promise<FewShotExample[]> {
    return readJsonFile<FewShotExample[]>(this.path, []);
  }
  async add(ex: FewShotExample): Promise<void> {
    const all = await this.load();
    if (ex.itemId !== undefined) {
      const idx = all.findIndex((e) => e.itemId === ex.itemId);
      if (idx >= 0) all[idx] = ex;
      else all.push(ex);
    } else {
      all.push(ex);
    }
    await writeJsonFileAtomic(this.dir, this.path, all);
  }
}
```

- [ ] **Step 6: Seed the `conversion/` steering config**

Create `conversion/x.md`:

```markdown
# X (트위터) 아이템 변환 지침

승인된 한글 번역을 **X(트위터) 게시용 카피**로 재작성합니다.

- 간결하고 임팩트 있게. 핵심 메시지를 앞에 둡니다.
- 원문 번역의 사실·수치·용어는 유지하되, 트윗 톤으로 다듬습니다.
- 해시태그·멘션·링크는 보존합니다. 과한 이모지는 지양합니다.
- 필요하면 스레드로 나눌 수 있게 문단을 끊어 씁니다.
```

Create `conversion/kol.md`:

```markdown
# KOL 브리프 변환 지침

승인된 한글 번역을 **KOL(인플루언서) 배포용 브리프**로 재작성합니다.

- KOL이 자신의 말로 옮기기 쉽도록 핵심 포인트를 정리합니다.
- 꼭 전달할 메시지, 링크, 주의사항(가격 언급 금지 등)을 명확히 합니다.
- 정중하고 협업적인 톤. 지시가 아니라 안내로 씁니다.
```

Create `conversion/pr.md`:

```markdown
# PR 보도자료 변환 지침

승인된 한글 번역을 **미디어 배포용 보도자료(PR)** 문체로 재작성합니다.

- 제목 + 본문 구조. 첫 줄은 기사 제목처럼 명료하게.
- 객관적·격식 있는 문어체. 과장·홍보 수식은 절제합니다.
- 사실·수치·인용은 정확히. 맥락을 문장으로 풀어 씁니다.
```

Create `conversion/few-shot.x.json`, `conversion/few-shot.kol.json`, `conversion/few-shot.pr.json` — each with an empty array so the flywheel starts clean:

```json
[]
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/store/FileConversionConfig.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ports/ConversionConfig.ts src/adapters/store/FileConversionConfig.ts src/adapters/store/JsonTypedFewShotStore.ts tests/adapters/store/FileConversionConfig.test.ts conversion
git commit -m "feat: ConversionConfig + typed few-shot store + seed conversion/ config (§5)"
```

---

## Task 4: §5 `PrepareConversions` use-case

**Files:**
- Create: `src/app/PrepareConversions.ts`
- Test: `tests/app/PrepareConversions.test.ts`

**Interfaces:**
- Consumes: `TranslationStore`, `GlossaryStore`, `TranslationConfig` (locale), `ConversionConfig`, `FewShotStore` (per type), `ConversionStore`; assembler funcs from Task 1; `ALL_TYPES`/`ConversionType` from models.
- Produces:
  - `interface ConversionSelector { ids?: string[]; since?: string; limit?: number; types?: ConversionType[] }`
  - `interface PendingVariant { itemId: string; type: ConversionType; sourceKorean: string }`
  - `class PrepareConversions` with constructor `(translationStore, glossaryStore, config, conversionConfig, fewShotByType: Record<ConversionType, FewShotStore>, conversionStore)` and `run(selector): Promise<{ worksheet: string; pending: PendingVariant[] }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/PrepareConversions.test.ts
import { describe, it, expect } from "vitest";
import { PrepareConversions } from "../../src/app/PrepareConversions";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ConversionConfig } from "../../src/ports/ConversionConfig";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { ConversionType } from "../../src/domain/conversion/models";
import type { Translation, Locale } from "../../src/domain/translation/models";

const locale: Locale = { dateFormat: "d", numberFormat: "n", currency: "USD", unit: "u", honorific: "합니다체" };

function tr(itemId: string, status: Translation["status"], ko: string): Translation {
  return { itemId, source: "x", sourceText: `src-${itemId}`, koreanText: ko, status, translatedAt: "2026-01-01T00:00:00.000Z",
    approvedAt: status === "approved" ? "2026-01-02T00:00:00.000Z" : undefined };
}
const translationStore = (list: Translation[]): TranslationStore => ({
  loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set(),
});
const glossaryStore: GlossaryStore = { load: async () => [], upsertEntry: async () => {} };
const config: TranslationConfig = { loadStyleGuide: async () => ({ text: "" }), loadLocale: async () => locale };
const conversionConfig: ConversionConfig = { loadTypeGuide: async (t) => ({ text: `guide-${t}` }) };
const emptyFewShot = (): FewShotStore => ({ load: async () => [], add: async () => {} });
const fewShotByType = (): Record<ConversionType, FewShotStore> => ({ x: emptyFewShot(), kol: emptyFewShot(), pr: emptyFewShot() });
const convStore = (keys: string[] = []): ConversionStore => ({
  loadAll: async () => [], upsert: async () => {}, listConvertedKeys: async () => new Set(keys),
});

describe("PrepareConversions", () => {
  it("fans approved translations into all types by default, skipping already-converted (itemId,type)", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "승인 카피"), tr("x:2", "translated", "미승인")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(["x:1:x"]),
    );
    const { worksheet, pending } = await uc.run({});
    // x:2 is not approved → excluded; x:1 approved → kol + pr (x already converted)
    expect(pending).toEqual([
      { itemId: "x:1", type: "kol", sourceKorean: "승인 카피" },
      { itemId: "x:1", type: "pr", sourceKorean: "승인 카피" },
    ]);
    expect(worksheet).toContain("guide-kol");
    expect(worksheet).toContain("guide-pr");
    expect(worksheet).not.toContain("## 유형: X");
    expect(worksheet).toContain("승인 카피");
  });

  it("honors --types and --ids and --limit", async () => {
    const uc = new PrepareConversions(
      translationStore([tr("x:1", "approved", "a"), tr("x:2", "approved", "b")]),
      glossaryStore, config, conversionConfig, fewShotByType(), convStore(),
    );
    const { pending } = await uc.run({ types: ["x"], ids: ["x:2"], limit: 5 });
    expect(pending).toEqual([{ itemId: "x:2", type: "x", sourceKorean: "b" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/PrepareConversions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

```ts
// src/app/PrepareConversions.ts
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { assembleConversionWorksheet, assembleTypeSection } from "../domain/conversion/promptAssembler";
import type { TranslationStore } from "../ports/TranslationStore";
import type { GlossaryStore } from "../ports/GlossaryStore";
import type { TranslationConfig } from "../ports/TranslationConfig";
import type { ConversionConfig } from "../ports/ConversionConfig";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FewShotStore } from "../ports/FewShotStore";

export interface ConversionSelector {
  ids?: string[];
  since?: string;
  limit?: number;
  types?: ConversionType[];
}

export interface PendingVariant {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
}

const DEFAULT_LIMIT = 20;
const MAX_FEW_SHOTS = 8;

export class PrepareConversions {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly glossaryStore: GlossaryStore,
    private readonly config: TranslationConfig,
    private readonly conversionConfig: ConversionConfig,
    private readonly fewShotByType: Record<ConversionType, FewShotStore>,
    private readonly conversionStore: ConversionStore,
  ) {}

  async run(selector: ConversionSelector): Promise<{ worksheet: string; pending: PendingVariant[] }> {
    const approved = (await this.translationStore.loadAll()).filter((t) => t.status === "approved");
    const convertedKeys = await this.conversionStore.listConvertedKeys();
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;

    let candidates: (PendingVariant & { at: string })[] = [];
    for (const type of types) {
      for (const t of approved) {
        if (convertedKeys.has(`${t.itemId}:${type}`)) continue;
        candidates.push({ itemId: t.itemId, type, sourceKorean: t.koreanText, at: t.approvedAt ?? t.translatedAt });
      }
    }
    if (wantedIds) candidates = candidates.filter((c) => wantedIds.has(c.itemId));
    if (selector.since) {
      const since = selector.since;
      candidates = candidates.filter((c) => c.at >= since);
    }
    candidates = candidates.slice(0, selector.limit ?? DEFAULT_LIMIT);

    const glossary = await this.glossaryStore.load();
    const locale = await this.config.loadLocale();

    const sections: string[] = [];
    for (const type of types) {
      const items = candidates.filter((c) => c.type === type).map((c) => ({ itemId: c.itemId, sourceKorean: c.sourceKorean }));
      if (items.length === 0) continue;
      const guide = await this.conversionConfig.loadTypeGuide(type);
      const fewShots = (await this.fewShotByType[type].load()).slice(-MAX_FEW_SHOTS);
      sections.push(assembleTypeSection({ type, guideText: guide.text, glossary, locale, fewShots, items }));
    }

    const worksheet = assembleConversionWorksheet(sections);
    const pending = candidates.map((c) => ({ itemId: c.itemId, type: c.type, sourceKorean: c.sourceKorean }));
    return { worksheet, pending };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/PrepareConversions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/PrepareConversions.ts tests/app/PrepareConversions.test.ts
git commit -m "feat: PrepareConversions use-case (§5)"
```

---

## Task 5: §5 `SaveConversion` use-case

**Files:**
- Create: `src/app/SaveConversion.ts`
- Test: `tests/app/SaveConversion.test.ts`

**Interfaces:**
- Consumes: `ConversionStore`, `FewShotStore` (per type), `ContentVariant`/`ConversionType`.
- Produces:
  - `interface SaveConversionInput { itemId: string; type: ConversionType; sourceKorean: string; convertedText: string; approve: boolean }`
  - `class SaveConversion` constructor `(conversionStore, fewShotByType: Record<ConversionType, FewShotStore>, now?)` and `run(input): Promise<{ itemId: string; type: ConversionType; promoted: boolean }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/SaveConversion.test.ts
import { describe, it, expect } from "vitest";
import { SaveConversion } from "../../src/app/SaveConversion";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { ContentVariant, ConversionType } from "../../src/domain/conversion/models";
import type { FewShotExample } from "../../src/domain/translation/models";

function harness() {
  const saved: ContentVariant[] = [];
  const store: ConversionStore = {
    loadAll: async () => saved, listConvertedKeys: async () => new Set(),
    upsert: async (v) => { saved.push(v); },
  };
  const fewShots: Record<ConversionType, FewShotExample[]> = { x: [], kol: [], pr: [] };
  const mk = (t: ConversionType): FewShotStore => ({ load: async () => fewShots[t], add: async (e) => { fewShots[t].push(e); } });
  const fewShotByType = { x: mk("x"), kol: mk("kol"), pr: mk("pr") };
  return { saved, fewShots, store, fewShotByType };
}

describe("SaveConversion", () => {
  it("saves as converted without approval and does not touch few-shot", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, h.fewShotByType, () => "2026-02-02T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", approve: false });
    expect(res).toEqual({ itemId: "x:1", type: "x", promoted: false });
    expect(h.saved[0].status).toBe("converted");
    expect(h.saved[0].approvedAt).toBeUndefined();
    expect(h.fewShots.x).toHaveLength(0);
  });

  it("approves → status approved + appends to that type's few-shot only", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, h.fewShotByType, () => "2026-02-02T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "kol", sourceKorean: "한글", convertedText: "브리프", approve: true });
    expect(res.promoted).toBe(true);
    expect(h.saved[0].status).toBe("approved");
    expect(h.saved[0].approvedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(h.fewShots.kol).toEqual([{ source: "한글", target: "브리프", itemId: "x:1" }]);
    expect(h.fewShots.x).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/SaveConversion.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

```ts
// src/app/SaveConversion.ts
import type { ContentVariant, ConversionType } from "../domain/conversion/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FewShotStore } from "../ports/FewShotStore";

export interface SaveConversionInput {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
  convertedText: string;
  approve: boolean;
}

export class SaveConversion {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly fewShotByType: Record<ConversionType, FewShotStore>,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveConversionInput): Promise<{ itemId: string; type: ConversionType; promoted: boolean }> {
    const timestamp = this.now();
    const variant: ContentVariant = {
      itemId: input.itemId,
      type: input.type,
      sourceKorean: input.sourceKorean,
      convertedText: input.convertedText,
      status: input.approve ? "approved" : "converted",
      createdAt: timestamp,
      approvedAt: input.approve ? timestamp : undefined,
    };
    await this.conversionStore.upsert(variant);
    if (input.approve) {
      await this.fewShotByType[input.type].add({ source: input.sourceKorean, target: input.convertedText, itemId: input.itemId });
    }
    return { itemId: input.itemId, type: input.type, promoted: input.approve };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/SaveConversion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/SaveConversion.ts tests/app/SaveConversion.test.ts
git commit -m "feat: SaveConversion use-case (§5)"
```

---

## Task 6: §5 CLIs — `convert:prepare` + `convert:save`

**Files:**
- Create: `src/cli/convert-prepare.ts`
- Create: `src/cli/convert-save.ts`
- Modify: `package.json` (add two scripts)

**Interfaces:**
- Consumes: `PrepareConversions`/`ConversionSelector`/`PendingVariant`, `SaveConversion`, all §5 adapters, `ALL_TYPES`/`ConversionType`.
- Produces: two runnable CLIs. No unit test (matches the untested `translate-*` CLIs); verified by typecheck + a manual smoke run.

- [ ] **Step 1: Write `convert-prepare.ts`**

```ts
// src/cli/convert-prepare.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { FileConversionConfig } from "../adapters/store/FileConversionConfig";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonTypedFewShotStore } from "../adapters/store/JsonTypedFewShotStore";
import { PrepareConversions, type ConversionSelector } from "../app/PrepareConversions";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { FewShotStore } from "../ports/FewShotStore";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

const selector: ConversionSelector = {};
const ids = parseList(argValue("--ids"));
if (ids) selector.ids = ids;
const since = argValue("--since");
if (since) selector.since = since;
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (Number.isFinite(n)) selector.limit = n;
}
const typesArg = parseList(argValue("--types"));
if (typesArg) {
  const invalid = typesArg.filter((t) => !ALL_TYPES.includes(t as ConversionType));
  if (invalid.length > 0) throw new Error(`Invalid --types: ${invalid.join(", ")} (allowed: ${ALL_TYPES.join(", ")})`);
  selector.types = typesArg as ConversionType[];
}

const fewShotByType: Record<ConversionType, FewShotStore> = {
  x: new JsonTypedFewShotStore("conversion", "x"),
  kol: new JsonTypedFewShotStore("conversion", "kol"),
  pr: new JsonTypedFewShotStore("conversion", "pr"),
};

const usecase = new PrepareConversions(
  new JsonTranslationStore("output/translations"),
  new JsonGlossaryStore("translation"),
  new FileTranslationConfig("translation"),
  new FileConversionConfig("conversion"),
  fewShotByType,
  new JsonConversionStore("output/variants"),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir("output/variants/worksheets", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join("output/variants/worksheets", `batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(join("output/variants", "pending.json"), `${JSON.stringify(pending, null, 2)}\n`, "utf8");

console.log(`prepared ${pending.length} variant(s) → ${worksheetPath}`);
console.log("Fill each 변환 section, then run: pnpm convert:save --id <id> --type <x|kol|pr> --file <ko.txt> [--approve]");
```

- [ ] **Step 2: Write `convert-save.ts`**

```ts
// src/cli/convert-save.ts
import { readFile } from "node:fs/promises";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonTypedFewShotStore } from "../adapters/store/JsonTypedFewShotStore";
import { SaveConversion } from "../app/SaveConversion";
import { readJsonFile } from "../shared/store/jsonFile";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import type { PendingVariant } from "../app/PrepareConversions";
import type { FewShotStore } from "../ports/FewShotStore";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = argValue("--id");
const type = argValue("--type") as ConversionType | undefined;
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !type || !file || !ALL_TYPES.includes(type)) {
  throw new Error("Usage: pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]");
}

const pending = await readJsonFile<PendingVariant[]>("output/variants/pending.json", []);
const item = pending.find((p) => p.itemId === id && p.type === type);
if (!item) {
  throw new Error(`Variant ${id}/${type} not found in output/variants/pending.json (run convert:prepare first)`);
}

const convertedText = (await readFile(file, "utf8")).trim();

const fewShotByType: Record<ConversionType, FewShotStore> = {
  x: new JsonTypedFewShotStore("conversion", "x"),
  kol: new JsonTypedFewShotStore("conversion", "kol"),
  pr: new JsonTypedFewShotStore("conversion", "pr"),
};

const usecase = new SaveConversion(new JsonConversionStore("output/variants"), fewShotByType);
const res = await usecase.run({ itemId: item.itemId, type: item.type, sourceKorean: item.sourceKorean, convertedText, approve });

console.log(`saved ${res.itemId}/${res.type}${res.promoted ? " (approved → few-shot)" : ""}`);
```

- [ ] **Step 3: Register the scripts**

In `package.json` `scripts`, after the `translate:save` line, add:

```json
    "convert:prepare": "tsx src/cli/convert-prepare.ts",
    "convert:save": "tsx src/cli/convert-save.ts",
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Seed one approved translation, then prepare:

```bash
mkdir -p output/translations
node -e "require('fs').writeFileSync('output/translations/translations.json', JSON.stringify([{itemId:'x:smoke',source:'x',sourceText:'hi',koreanText:'안녕하세요 맨틀입니다',status:'approved',translatedAt:'2026-01-01T00:00:00.000Z',approvedAt:'2026-01-02T00:00:00.000Z'}], null, 2))"
pnpm convert:prepare --types x
```
Expected: prints `prepared 1 variant(s) → output/variants/worksheets/batch-*.md`; the worksheet contains `## 유형: X` and `안녕하세요 맨틀입니다`.

Fill and save:

```bash
echo "안녕하세요! 맨틀입니다 🚀" > /tmp/ko.txt
pnpm convert:save --id x:smoke --type x --file /tmp/ko.txt --approve
```
Expected: prints `saved x:smoke/x (approved → few-shot)`; `output/variants/variants.json` has the variant with `status: "approved"`; `conversion/few-shot.x.json` has one example.

Clean up the smoke artifacts (do NOT commit them — `output/` is git-ignored, but reset the seeded translation and few-shot):

```bash
rm -rf output/variants
git checkout conversion/few-shot.x.json
rm -f output/translations/translations.json
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/convert-prepare.ts src/cli/convert-save.ts package.json
git commit -m "feat: convert:prepare + convert:save CLIs (§5)"
```

---

## Task 7: §6 domain — channel formatters

**Files:**
- Create: `src/domain/formatting/models.ts`
- Create: `src/domain/formatting/channelFormat.ts`
- Test: `tests/domain/formatting/channelFormat.test.ts`

**Interfaces:**
- Consumes: `ConversionType` from `src/domain/conversion/models.ts`.
- Produces:
  - `type Channel = "x" | "telegram" | "kakao" | "pr_mail"`
  - `const ALL_CHANNELS: Channel[]`
  - `const DEFAULT_CHANNELS_BY_TYPE: Record<ConversionType, Channel[]>`
  - `interface FormatOptions { xBold?: "plain" | "unicode" }`
  - `interface FormatResult { text: string; warnings: string[] }`
  - `interface ChannelRendering { itemId: string; type: ConversionType; channel: Channel; text: string; refined: boolean; createdAt: string }`
  - `function formatForChannel(text: string, channel: Channel, opts?: FormatOptions): FormatResult`

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/formatting/channelFormat.test.ts
import { describe, it, expect } from "vitest";
import { formatForChannel, DEFAULT_CHANNELS_BY_TYPE, ALL_CHANNELS } from "../../../src/domain/formatting/channelFormat";

describe("DEFAULT_CHANNELS_BY_TYPE", () => {
  it("maps each type to its default channels", () => {
    expect(DEFAULT_CHANNELS_BY_TYPE.x).toEqual(["x", "kakao"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toEqual(["telegram"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.pr).toEqual(["pr_mail"]);
    expect(ALL_CHANNELS).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});

describe("formatForChannel — x", () => {
  it("strips bold to plain by default and preserves hashtags/mentions/links", () => {
    const r = formatForChannel("**메인넷** 출시! #Mantle @Mantle_Official https://t.co/x", "x");
    expect(r.text).toBe("메인넷 출시! #Mantle @Mantle_Official https://t.co/x");
    expect(r.warnings).toEqual([]);
  });
  it("maps bold to unicode (sans-serif bold) when opts.xBold=unicode", () => {
    const r = formatForChannel("**AB**", "x", { xBold: "unicode" });
    // U+1D5D4 = MATHEMATICAL SANS-SERIF BOLD CAPITAL A, U+1D5D5 = ...B
    expect([...r.text].map((c) => c.codePointAt(0))).toEqual([0x1d5d4, 0x1d5d5]);
  });
  it("warns when the result exceeds 280 characters", () => {
    const r = formatForChannel("가".repeat(281), "x");
    expect(r.warnings.some((w) => w.includes("280"))).toBe(true);
  });
  it("collapses 3+ blank lines to a single blank line", () => {
    const r = formatForChannel("a\n\n\n\nb", "x");
    expect(r.text).toBe("a\n\nb");
  });
});

describe("formatForChannel — telegram", () => {
  it("converts **bold** to *bold* and keeps links", () => {
    const r = formatForChannel("**중요** 링크 https://x.io", "telegram");
    expect(r.text).toBe("*중요* 링크 https://x.io");
    expect(r.warnings).toEqual([]);
  });
});

describe("formatForChannel — kakao", () => {
  it("removes bold and rewrites markdown links to 'text (url)'", () => {
    const r = formatForChannel("**공지** [자세히](https://x.io)", "kakao");
    expect(r.text).toBe("공지 자세히 (https://x.io)");
  });
});

describe("formatForChannel — pr_mail", () => {
  it("uses the first line as 제목 and the rest as body, stripped of bold", () => {
    const r = formatForChannel("맨틀, 메인넷 출시\n\n**본문** 내용입니다.", "pr_mail");
    expect(r.text).toBe("제목: 맨틀, 메인넷 출시\n\n본문 내용입니다.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/formatting/channelFormat.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the models**

```ts
// src/domain/formatting/models.ts
import type { ConversionType } from "../conversion/models";

export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export const ALL_CHANNELS: Channel[] = ["x", "telegram", "kakao", "pr_mail"];

export const DEFAULT_CHANNELS_BY_TYPE: Record<ConversionType, Channel[]> = {
  x: ["x", "kakao"],
  kol: ["telegram"],
  pr: ["pr_mail"],
};

export interface FormatOptions {
  xBold?: "plain" | "unicode";
}

export interface FormatResult {
  text: string;
  warnings: string[];
}

/** One converted variant formatted for a specific channel. Identity is (itemId, type, channel). */
export interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean; // false = code formatter only; true = agent-refined
  createdAt: string;
}
```

- [ ] **Step 4: Create the formatter**

```ts
// src/domain/formatting/channelFormat.ts
import type { Channel, FormatOptions, FormatResult } from "./models";

export { ALL_CHANNELS, DEFAULT_CHANNELS_BY_TYPE } from "./models";
export type { Channel, FormatOptions, FormatResult, ChannelRendering } from "./models";

const X_LIMIT = 280;
const BOLD = /\*\*(.+?)\*\*/g;
const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

const collapseBlankLines = (t: string): string => t.replace(/\n{3,}/g, "\n\n");
const stripBold = (t: string): string => t.replace(BOLD, "$1");
const boldToTelegram = (t: string): string => t.replace(BOLD, "*$1*");
const linksToPlain = (t: string): string => t.replace(MD_LINK, "$1 ($2)");

/** Map ASCII letters/digits inside **bold** to Unicode Sans-Serif Bold (reads naturally on X). */
function boldToUnicode(t: string): string {
  return t.replace(BOLD, (_m, inner: string) =>
    [...inner]
      .map((ch) => {
        const c = ch.codePointAt(0)!;
        if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(0x1d5d4 + (c - 0x41)); // A-Z
        if (c >= 0x61 && c <= 0x7a) return String.fromCodePoint(0x1d5ee + (c - 0x61)); // a-z
        if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1d7ec + (c - 0x30)); // 0-9
        return ch;
      })
      .join(""),
  );
}

export function formatForChannel(text: string, channel: Channel, opts: FormatOptions = {}): FormatResult {
  const warnings: string[] = [];
  switch (channel) {
    case "x": {
      const out = collapseBlankLines(opts.xBold === "unicode" ? boldToUnicode(text) : stripBold(text)).trim();
      if ([...out].length > X_LIMIT) warnings.push(`exceeds ${X_LIMIT} chars (${[...out].length}); consider splitting into a thread`);
      return { text: out, warnings };
    }
    case "telegram":
      return { text: collapseBlankLines(boldToTelegram(text)).trim(), warnings };
    case "kakao":
      return { text: collapseBlankLines(linksToPlain(stripBold(text))).trim(), warnings };
    case "pr_mail": {
      const plain = linksToPlain(stripBold(text)).trim();
      const lines = plain.split("\n");
      const subject = (lines.shift() ?? "").trim();
      const body = collapseBlankLines(lines.join("\n")).trim();
      return { text: `제목: ${subject}\n\n${body}`, warnings };
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/formatting/channelFormat.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck & commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add src/domain/formatting tests/domain/formatting
git commit -m "feat: channel formatters (X / Telegram / KakaoTalk / PR-mail) (§6)"
```

---

## Task 8: §6 `FormattingStore` port + `JsonFormattingStore`

**Files:**
- Create: `src/ports/FormattingStore.ts`
- Create: `src/adapters/store/JsonFormattingStore.ts`
- Test: `tests/adapters/store/JsonFormattingStore.test.ts`

**Interfaces:**
- Consumes: `ChannelRendering` from `src/domain/formatting/models.ts`; `readJsonFile`/`writeJsonFileAtomic`.
- Produces:
  - `interface FormattingStore { loadAll(): Promise<ChannelRendering[]>; upsert(r: ChannelRendering): Promise<void>; listRenderedKeys(): Promise<Set<string>> }`
  - `class JsonFormattingStore implements FormattingStore` (constructor `(dir)`, file `renderings.json`, key `` `${itemId}:${type}:${channel}` ``)

- [ ] **Step 1: Write the failing test**

```ts
// tests/adapters/store/JsonFormattingStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFormattingStore } from "../../../src/adapters/store/JsonFormattingStore";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "fmt-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonFormattingStore", () => {
  it("upserts by (itemId, type, channel)", async () => {
    const store = new JsonFormattingStore(dir);
    await store.upsert(rendering({ text: "v1" }));
    await store.upsert(rendering({ text: "v2" }));                       // replace
    await store.upsert(rendering({ channel: "kakao", text: "k" }));      // new channel
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.channel === "x")?.text).toBe("v2");
  });

  it("listRenderedKeys returns `${itemId}:${type}:${channel}`", async () => {
    const store = new JsonFormattingStore(dir);
    await store.upsert(rendering());
    await store.upsert(rendering({ type: "kol", channel: "telegram" }));
    expect(await store.listRenderedKeys()).toEqual(new Set(["x:1:x:x", "x:1:kol:telegram"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/store/JsonFormattingStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the port**

```ts
// src/ports/FormattingStore.ts
import type { ChannelRendering } from "../domain/formatting/models";

export interface FormattingStore {
  loadAll(): Promise<ChannelRendering[]>;
  upsert(r: ChannelRendering): Promise<void>; // by (itemId, type, channel)
  listRenderedKeys(): Promise<Set<string>>; // `${itemId}:${type}:${channel}`
}
```

- [ ] **Step 4: Create the adapter**

```ts
// src/adapters/store/JsonFormattingStore.ts
import { join } from "node:path";
import type { ChannelRendering } from "../../domain/formatting/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

const key = (r: Pick<ChannelRendering, "itemId" | "type" | "channel">) => `${r.itemId}:${r.type}:${r.channel}`;

export class JsonFormattingStore implements FormattingStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "renderings.json");
  }
  async loadAll(): Promise<ChannelRendering[]> {
    return readJsonFile<ChannelRendering[]>(this.path, []);
  }
  async upsert(r: ChannelRendering): Promise<void> {
    const all = await this.loadAll();
    const byKey = new Map(all.map((x) => [key(x), x]));
    byKey.set(key(r), r);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
  async listRenderedKeys(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map(key));
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/store/JsonFormattingStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ports/FormattingStore.ts src/adapters/store/JsonFormattingStore.ts tests/adapters/store/JsonFormattingStore.test.ts
git commit -m "feat: FormattingStore port + JsonFormattingStore (§6)"
```

---

## Task 9: §6 `FormatVariants` use-case (code path)

**Files:**
- Create: `src/app/FormatVariants.ts`
- Test: `tests/app/FormatVariants.test.ts`

**Interfaces:**
- Consumes: `ConversionStore`, `FormattingStore`, `formatForChannel`, `DEFAULT_CHANNELS_BY_TYPE`, `ALL_TYPES`, `Channel`, `FormatOptions`.
- Produces:
  - `interface FormatSelector { ids?: string[]; types?: ConversionType[]; channels?: Channel[] }`
  - `interface FormatWarning { itemId: string; type: ConversionType; channel: Channel; messages: string[] }`
  - `class FormatVariants` constructor `(conversionStore, formattingStore, opts?: FormatOptions, now?)`, `run(selector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/FormatVariants.test.ts
import { describe, it, expect } from "vitest";
import { FormatVariants } from "../../src/app/FormatVariants";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function stores(variants: ContentVariant[]) {
  const conversionStore: ConversionStore = { loadAll: async () => variants, upsert: async () => {}, listConvertedKeys: async () => new Set() };
  const saved: ChannelRendering[] = [];
  const formattingStore: FormattingStore = { loadAll: async () => saved, listRenderedKeys: async () => new Set(), upsert: async (r) => { saved.push(r); } };
  return { conversionStore, formattingStore, saved };
}

describe("FormatVariants", () => {
  it("formats approved variants to their default channels and persists refined:false renderings", async () => {
    const s = stores([variant()]); // x → default channels [x, kakao]
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, {}, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({});
    expect(renderings.map((r) => r.channel)).toEqual(["x", "kakao"]);
    expect(renderings.every((r) => r.refined === false)).toBe(true);
    expect(s.saved).toHaveLength(2);
  });

  it("ignores non-approved variants", async () => {
    const s = stores([variant({ status: "converted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings } = await uc.run({});
    expect(renderings).toHaveLength(0);
  });

  it("honors --channels override and collects warnings", async () => {
    const s = stores([variant({ convertedText: "가".repeat(281) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings, warnings } = await uc.run({ channels: ["x"] });
    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(warnings[0].messages.some((m) => m.includes("280"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/FormatVariants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

```ts
// src/app/FormatVariants.ts
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { formatForChannel } from "../domain/formatting/channelFormat";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering, type FormatOptions } from "../domain/formatting/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormattingStore } from "../ports/FormattingStore";

export interface FormatSelector {
  ids?: string[];
  types?: ConversionType[];
  channels?: Channel[];
}

export interface FormatWarning {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  messages: string[];
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    private readonly opts: FormatOptions = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(selector: FormatSelector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
    const approved = (await this.conversionStore.loadAll()).filter(
      (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
    );

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      for (const channel of channels) {
        const result = formatForChannel(v.convertedText, channel, this.opts);
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text: result.text, refined: false, createdAt: this.now(),
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        if (result.warnings.length > 0) warnings.push({ itemId: v.itemId, type: v.type, channel, messages: result.warnings });
      }
    }
    return { renderings, warnings };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/FormatVariants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/FormatVariants.ts tests/app/FormatVariants.test.ts
git commit -m "feat: FormatVariants use-case — code formatting path (§6)"
```

---

## Task 10: §6 refinement — worksheet + `PrepareRefinements` + `SaveRendering`

**Files:**
- Create: `src/domain/formatting/refinementWorksheet.ts`
- Create: `src/app/PrepareRefinements.ts`
- Create: `src/app/SaveRendering.ts`
- Test: `tests/domain/formatting/refinementWorksheet.test.ts`
- Test: `tests/app/SaveRendering.test.ts`

**Interfaces:**
- Consumes: `formatForChannel`, `DEFAULT_CHANNELS_BY_TYPE`, `ALL_TYPES`, `ConversionStore`, `FormattingStore`, `Channel`, `ChannelRendering`, `typeLabel`, `FormatSelector` (from Task 9).
- Produces:
  - `interface RefinementDraft { itemId: string; type: ConversionType; channel: Channel; draft: string }`
  - `function assembleRefinementWorksheet(drafts: RefinementDraft[]): string`
  - `interface PendingRendering { itemId: string; type: ConversionType; channel: Channel }`
  - `class PrepareRefinements` constructor `(conversionStore, opts?, )`, `run(selector: FormatSelector): Promise<{ worksheet: string; pending: PendingRendering[] }>`
  - `interface SaveRenderingInput { itemId: string; type: ConversionType; channel: Channel; text: string }`
  - `class SaveRendering` constructor `(formattingStore, now?)`, `run(input): Promise<{ itemId: string; type: ConversionType; channel: Channel }>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/domain/formatting/refinementWorksheet.test.ts
import { describe, it, expect } from "vitest";
import { assembleRefinementWorksheet } from "../../../src/domain/formatting/refinementWorksheet";

describe("assembleRefinementWorksheet", () => {
  it("emits a header and one block per draft with 초안 and an empty 보정 slot", () => {
    const out = assembleRefinementWorksheet([
      { itemId: "x:1", type: "x", channel: "x", draft: "X 초안 텍스트" },
      { itemId: "x:1", type: "kol", channel: "telegram", draft: "*텔레그램*" },
    ]);
    expect(out).toContain("보정");
    expect(out).toContain("## x:1 · X · x");
    expect(out).toContain("X 초안 텍스트");
    expect(out).toContain("## x:1 · KOL · telegram");
    expect(out).toContain("초안:");
    expect(out.trimEnd().endsWith("보정:")).toBe(true);
  });
});
```

```ts
// tests/app/SaveRendering.test.ts
import { describe, it, expect } from "vitest";
import { SaveRendering } from "../../src/app/SaveRendering";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelRendering } from "../../src/domain/formatting/models";

describe("SaveRendering", () => {
  it("upserts a refined:true rendering", async () => {
    const saved: ChannelRendering[] = [];
    const store: FormattingStore = { loadAll: async () => saved, listRenderedKeys: async () => new Set(), upsert: async (r) => { saved.push(r); } };
    const uc = new SaveRendering(store, () => "2026-04-04T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트" });
    expect(res).toEqual({ itemId: "x:1", type: "kol", channel: "telegram" });
    expect(saved[0]).toEqual({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트", refined: true, createdAt: "2026-04-04T00:00:00.000Z" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/domain/formatting/refinementWorksheet.test.ts tests/app/SaveRendering.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create the refinement worksheet assembler**

```ts
// src/domain/formatting/refinementWorksheet.ts
import { typeLabel, type ConversionType } from "../conversion/models";
import type { Channel } from "./models";

export interface RefinementDraft {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  draft: string;
}

export function assembleRefinementWorksheet(drafts: RefinementDraft[]): string {
  const blocks = drafts.map((d) =>
    [`## ${d.itemId} · ${typeLabel(d.type)} · ${d.channel}`, "초안:", d.draft, "보정:", ""].join("\n"),
  );
  return [
    "# Mantle KR 채널 포매팅 보정 작업",
    "",
    "아래 각 블록의 `초안:`(코드 포매터 결과)을 채널 특성에 맞게 다듬어 `보정:` 아래에 채워 주세요.",
    "",
    ...blocks,
  ].join("\n");
}
```

- [ ] **Step 4: Create `PrepareRefinements`**

```ts
// src/app/PrepareRefinements.ts
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { formatForChannel } from "../domain/formatting/channelFormat";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type FormatOptions } from "../domain/formatting/models";
import { assembleRefinementWorksheet, type RefinementDraft } from "../domain/formatting/refinementWorksheet";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormatSelector } from "./FormatVariants";

export interface PendingRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class PrepareRefinements {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly opts: FormatOptions = {},
  ) {}

  async run(selector: FormatSelector): Promise<{ worksheet: string; pending: PendingRendering[] }> {
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
    const approved = (await this.conversionStore.loadAll()).filter(
      (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
    );

    const drafts: RefinementDraft[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      for (const channel of channels) {
        drafts.push({ itemId: v.itemId, type: v.type, channel, draft: formatForChannel(v.convertedText, channel, this.opts).text });
      }
    }

    const worksheet = assembleRefinementWorksheet(drafts);
    const pending = drafts.map((d) => ({ itemId: d.itemId, type: d.type, channel: d.channel }));
    return { worksheet, pending };
  }
}
```

- [ ] **Step 5: Create `SaveRendering`**

```ts
// src/app/SaveRendering.ts
import type { ConversionType } from "../domain/conversion/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";

export interface SaveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
}

export class SaveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveRenderingInput): Promise<{ itemId: string; type: ConversionType; channel: Channel }> {
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, createdAt: this.now(),
    };
    await this.formattingStore.upsert(rendering);
    return { itemId: input.itemId, type: input.type, channel: input.channel };
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/formatting/refinementWorksheet.test.ts tests/app/SaveRendering.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/formatting/refinementWorksheet.ts src/app/PrepareRefinements.ts src/app/SaveRendering.ts tests/domain/formatting/refinementWorksheet.test.ts tests/app/SaveRendering.test.ts
git commit -m "feat: refinement worksheet + PrepareRefinements + SaveRendering (§6)"
```

---

## Task 11: §6 CLIs — `format` + `format:save`

**Files:**
- Create: `src/cli/format.ts`
- Create: `src/cli/format-save.ts`
- Modify: `package.json` (add two scripts)

**Interfaces:**
- Consumes: `FormatVariants`/`FormatSelector`, `PrepareRefinements`/`PendingRendering`, `SaveRendering`, `JsonConversionStore`, `JsonFormattingStore`, `ALL_TYPES`/`ConversionType`, `ALL_CHANNELS`/`Channel`.
- Produces: two runnable CLIs. Verified by typecheck + manual smoke run.

- [ ] **Step 1: Write `format.ts`**

```ts
// src/cli/format.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { FormatVariants, type FormatSelector } from "../app/FormatVariants";
import { PrepareRefinements } from "../app/PrepareRefinements";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel, type FormatOptions } from "../domain/formatting/models";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

const selector: FormatSelector = {};
const ids = parseList(argValue("--ids"));
if (ids) selector.ids = ids;
const typesArg = parseList(argValue("--types"));
if (typesArg) {
  const invalid = typesArg.filter((t) => !ALL_TYPES.includes(t as ConversionType));
  if (invalid.length > 0) throw new Error(`Invalid --types: ${invalid.join(", ")} (allowed: ${ALL_TYPES.join(", ")})`);
  selector.types = typesArg as ConversionType[];
}
const channelsArg = parseList(argValue("--channels"));
if (channelsArg) {
  const invalid = channelsArg.filter((c) => !ALL_CHANNELS.includes(c as Channel));
  if (invalid.length > 0) throw new Error(`Invalid --channels: ${invalid.join(", ")} (allowed: ${ALL_CHANNELS.join(", ")})`);
  selector.channels = channelsArg as Channel[];
}
const opts: FormatOptions = argValue("--x-bold") === "unicode" ? { xBold: "unicode" } : {};
const refine = process.argv.includes("--refine");

const conversionStore = new JsonConversionStore("output/variants");

if (refine) {
  const { worksheet, pending } = await new PrepareRefinements(conversionStore, opts).run(selector);
  await mkdir("output/formatted/worksheets", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worksheetPath = join("output/formatted/worksheets", `batch-${stamp}.md`);
  await writeFile(worksheetPath, worksheet, "utf8");
  await writeFile(join("output/formatted", "pending.json"), `${JSON.stringify(pending, null, 2)}\n`, "utf8");
  console.log(`prepared ${pending.length} refinement draft(s) → ${worksheetPath}`);
  console.log("Fill each 보정 section, then run: pnpm format:save --id <id> --type <t> --channel <c> --file <txt>");
} else {
  const { renderings, warnings } = await new FormatVariants(conversionStore, new JsonFormattingStore("output/formatted"), opts).run(selector);
  console.log(`formatted ${renderings.length} rendering(s) → output/formatted/renderings.json`);
  for (const w of warnings) console.log(`  ⚠ ${w.itemId}/${w.type}/${w.channel}: ${w.messages.join("; ")}`);
}
```

- [ ] **Step 2: Write `format-save.ts`**

```ts
// src/cli/format-save.ts
import { readFile } from "node:fs/promises";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { SaveRendering } from "../app/SaveRendering";
import { readJsonFile } from "../shared/store/jsonFile";
import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { ALL_CHANNELS, type Channel } from "../domain/formatting/models";
import type { PendingRendering } from "../app/PrepareRefinements";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = argValue("--id");
const type = argValue("--type") as ConversionType | undefined;
const channel = argValue("--channel") as Channel | undefined;
const file = argValue("--file");
if (!id || !type || !channel || !file || !ALL_TYPES.includes(type) || !ALL_CHANNELS.includes(channel)) {
  throw new Error("Usage: pnpm format:save --id <itemId> --type <x|kol|pr> --channel <x|telegram|kakao|pr_mail> --file <txt>");
}

const pending = await readJsonFile<PendingRendering[]>("output/formatted/pending.json", []);
const match = pending.find((p) => p.itemId === id && p.type === type && p.channel === channel);
if (!match) {
  throw new Error(`Rendering ${id}/${type}/${channel} not found in output/formatted/pending.json (run format --refine first)`);
}

const text = (await readFile(file, "utf8")).trim();
const res = await new SaveRendering(new JsonFormattingStore("output/formatted")).run({ itemId: match.itemId, type: match.type, channel: match.channel, text });
console.log(`saved ${res.itemId}/${res.type}/${res.channel} (refined)`);
```

- [ ] **Step 3: Register the scripts**

In `package.json` `scripts`, after the `convert:save` line, add:

```json
    "format": "tsx src/cli/format.ts",
    "format:save": "tsx src/cli/format-save.ts",
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Manual smoke test**

Seed one approved variant, then run the code path:

```bash
mkdir -p output/variants
node -e "require('fs').writeFileSync('output/variants/variants.json', JSON.stringify([{itemId:'x:smoke',type:'x',sourceKorean:'한글',convertedText:'**메인넷** 출시! #Mantle',status:'approved',createdAt:'2026-01-01T00:00:00.000Z',approvedAt:'2026-01-02T00:00:00.000Z'}], null, 2))"
pnpm format --types x --channels x
```
Expected: prints `formatted 1 rendering(s) → output/formatted/renderings.json`; that file's rendering has `text: "메인넷 출시! #Mantle"` and `refined: false`.

Now the refine path:

```bash
pnpm format --types x --channels x --refine
```
Expected: prints `prepared 1 refinement draft(s) → output/formatted/worksheets/batch-*.md`; the worksheet contains `## x:smoke · X · x` and `초안:` with the code-formatted draft.

```bash
echo "메인넷 출시! 🚀 #Mantle" > /tmp/x.txt
pnpm format:save --id x:smoke --type x --channel x --file /tmp/x.txt
```
Expected: prints `saved x:smoke/x/x (refined)`; the rendering in `output/formatted/renderings.json` now has `refined: true` and the new text.

Clean up (all under git-ignored `output/`):

```bash
rm -rf output/variants output/formatted
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/format.ts src/cli/format-save.ts package.json
git commit -m "feat: format + format:save CLIs (§6)"
```

---

## Task 12: Full-suite verification + docs

**Files:**
- Modify: `README.md` (add a Module F section)
- Modify: `CHANGELOG.md` (add entries under `[Unreleased]`)

**Interfaces:**
- Consumes: everything above. No new code.

- [ ] **Step 1: Run the full test suite + typecheck**

Run: `pnpm test`
Expected: all tests pass (existing suite + the ~9 new test files).

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Add a README section**

In `README.md`, after the Module E section, add:

```markdown
## Module F — Content shaping (item conversion + channel formatting)

Turns an **approved** Korean translation (Module E) into channel-ready posts, in two stages.

### §5 Item conversion (agent-assisted, like translation)

```bash
pnpm convert:prepare [--types x,kol,pr] [--ids a,b] [--since <ISO>] [--limit 20]
#   → output/variants/worksheets/batch-<ts>.md — fill each 변환 section
pnpm convert:save --id <itemId> --type <x|kol|pr> --file <ko.txt> [--approve]
```

Per-type steering config lives in `conversion/` (`x.md`, `kol.md`, `pr.md`, `few-shot.<type>.json`);
it reuses `translation/glossary.json` and `translation/locale.json`. `--approve` feeds a per-type few-shot flywheel.

### §6 Channel formatting (deterministic code + optional agent refinement)

```bash
pnpm format [--types x,kol,pr] [--channels x,telegram,kakao,pr_mail] [--ids a,b] [--x-bold unicode] [--refine]
#   default: writes ChannelRenderings from the code formatter to output/formatted/renderings.json
#   --refine: writes a refinement worksheet for the agent to fine-tune, then:
pnpm format:save --id <itemId> --type <t> --channel <c> --file <txt>
```

Default channels per type: `x → x, kakao` · `kol → telegram` · `pr → pr_mail`.
```

- [ ] **Step 3: Add CHANGELOG entries**

In `CHANGELOG.md`, replace the empty `## [Unreleased]` section with:

```markdown
## [Unreleased]

### Added

- **Content shaping (F)** — §5 item conversion (`convert:prepare` / `convert:save`) rewrites an
  approved translation into X / KOL / PR variants with per-type steering config in `conversion/`
  and a per-type few-shot flywheel; §6 channel formatting (`format` / `format:save`) renders a
  variant for X / Telegram / KakaoTalk / PR-mail with deterministic formatters and an optional
  agent refinement pass.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: Module F (content shaping) — README + CHANGELOG"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §5 conversion (Tasks 1–6), §6 formatting code path (Tasks 7–9), §6 refinement (Tasks 10–11), CLI surface (Tasks 6, 11), storage layout (Tasks 2, 3, 8 + CLIs), config reuse (Tasks 3, 4), type↔channel mapping (Task 7), testing (every task), docs (Task 12). §7/§8 explicitly out of scope — no tasks, by design.
- **Telegram v1 simplification:** the formatter targets Telegram legacy-Markdown (`*bold*`, links preserved) without full MarkdownV2 escaping; edge cases are the job of `--refine`. This is an intentional v1 scope call consistent with the spec's "channel-appropriate formatting" intent.
- **No new runtime deps:** everything uses `node:*` + existing helpers; zod-only runtime preserved.
