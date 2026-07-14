# Korean Translation (Subsystem C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble 6-element translation prompts (shared context once per batch + per-item content) from collected X/Lark content, and store agent-produced Korean translations with a few-shot flywheel — no Claude API (the local agent translates).

**Architecture:** Hexagonal. Pure `domain/translation` (ContentItem, models, promptAssembler). Ports (ContentSource, GlossaryStore, FewShotStore, TranslationStore, TranslationConfig). Adapters read A's `output/items.json` (CollectedThread) and B's `output/lark-items.json` (LarkMessage) into a source-agnostic `ContentItem`, and JSON stores over `data/` (living glossary/style/locale/few-shot) + `output/` (translations). Use-cases `PrepareTranslations` (assemble worksheet) and `SaveTranslation` (ingest + promote approved to few-shot). CLIs `translate-prepare` / `translate-save` / `glossary`.

**Tech Stack:** TypeScript (ESM), pnpm, Node 24, `zod`, `vitest`, `tsx`. No new dependencies. No secrets/env (no API).

## Global Constraints

- All code, identifiers, comments in English. Chat is Korean.
- ESM (`"type": "module"`), `moduleResolution: bundler` — imports need NO `.js` extension. Node built-ins as `node:...`.
- No new runtime deps. No Claude API call. No secrets.
- Reuse `src/shared/store/{jsonFile,WatermarkStore}` (from B). `readJsonFile`(ENOENT→fallback else throw) + `writeJsonFileAtomic`(temp+rename) for all persistence.
- The 6 elements: shared 5 (role/glossary/style-guide/locale/few-shot) assembled ONCE per batch; per-item = content (+ optional grounding). Never repeat the 5 per item.
- `ContentItem.id` = `"x:<rootId>"` | `"lark:<messageId>"`. Translation/store keyed by `itemId`.
- Data lives in `data/` (git-tracked, already seeded: glossary.json/style-guide.md/locale.json/few-shot.json). Translations + worksheets in `output/` (git-ignored).
- `PrepareTranslations` batch MUST be bounded (default `limit` 20) — never the whole backfill.
- TDD: failing test first for every unit with logic. Commit after each green task.
- Consumes existing types: `CollectedThread` (`src/domain/models.ts`, from A), `LarkMessage` (`src/domain/larkMessage.ts`, from B).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/domain/translation/contentItem.ts` | `ContentItem` type |
| `src/domain/translation/models.ts` | GlossaryEntry, StyleGuide, Locale, FewShotExample, Translation, SharedContext |
| `src/domain/translation/role.ts` | `DEFAULT_ROLE` system-prompt constant |
| `src/domain/translation/promptAssembler.ts` | pure `assembleSharedContext`, `assembleItemBlock` |
| `src/ports/ContentSource.ts` | `loadPending(translatedIds)` |
| `src/ports/GlossaryStore.ts` | `load` / `upsertEntry` |
| `src/ports/FewShotStore.ts` | `load` / `add` |
| `src/ports/TranslationStore.ts` | `loadAll` / `upsert` / `listTranslatedIds` |
| `src/ports/TranslationConfig.ts` | `loadStyleGuide` / `loadLocale` |
| `src/adapters/content/XContentSource.ts` | items.json → ContentItem |
| `src/adapters/content/LarkContentSource.ts` | lark-items.json → ContentItem |
| `src/adapters/content/CompositeContentSource.ts` | merge multiple sources |
| `src/adapters/store/JsonGlossaryStore.ts` | data/glossary.json |
| `src/adapters/store/JsonFewShotStore.ts` | data/few-shot.json |
| `src/adapters/store/JsonTranslationStore.ts` | output/translations.json |
| `src/adapters/store/FileTranslationConfig.ts` | data/style-guide.md, data/locale.json |
| `src/app/PrepareTranslations.ts` | selector + shared context + worksheet |
| `src/app/SaveTranslation.ts` | ingest + few-shot promotion |
| `src/cli/translate-prepare.ts`, `translate-save.ts`, `glossary.ts` | composition roots |
| `tests/**` | vitest unit tests |

---

## Task 1: Domain models + ContentItem + role

**Files:**
- Create: `src/domain/translation/contentItem.ts`, `src/domain/translation/models.ts`, `src/domain/translation/role.ts`
- Test: `tests/domain/translation/models.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ContentItem { id: string; source: "x"|"lark"; text: string; createdAt: string; refUrl?: string }`
  - `GlossaryRule = "translate"|"transliterate"|"keep"`
  - `GlossaryEntry { term: string; rule: GlossaryRule; target?: string; note?: string; updatedAt: string; source?: string }`
  - `StyleGuide { text: string }`
  - `Locale { dateFormat: string; numberFormat: string; currency: string; unit: string; honorific: string }`
  - `FewShotExample { source: string; target: string; itemId?: string }`
  - `TranslationStatus = "translated"|"approved"`
  - `Translation { itemId: string; source: "x"|"lark"; sourceText: string; koreanText: string; status: TranslationStatus; translatedAt: string; approvedAt?: string }`
  - `SharedContext { role: string; glossary: GlossaryEntry[]; styleGuide: StyleGuide; locale: Locale; fewShots: FewShotExample[] }`
  - `DEFAULT_ROLE: string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/translation/models.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_ROLE } from "../../../src/domain/translation/role";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { Translation } from "../../../src/domain/translation/models";

describe("translation domain", () => {
  it("DEFAULT_ROLE is a non-empty translator persona", () => {
    expect(typeof DEFAULT_ROLE).toBe("string");
    expect(DEFAULT_ROLE.length).toBeGreaterThan(0);
  });

  it("ContentItem and Translation types are usable", () => {
    const item: ContentItem = { id: "x:1", source: "x", text: "hi", createdAt: "2026-01-01T00:00:00.000Z" };
    const t: Translation = {
      itemId: item.id, source: "x", sourceText: "hi", koreanText: "안녕",
      status: "translated", translatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(t.itemId).toBe("x:1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/translation/models.test.ts`
Expected: FAIL — cannot resolve modules.

- [ ] **Step 3: Write `src/domain/translation/contentItem.ts`**

```ts
export interface ContentItem {
  id: string; // "x:<rootId>" | "lark:<messageId>"
  source: "x" | "lark";
  text: string; // source text to translate
  createdAt: string; // ISO
  refUrl?: string;
}
```

- [ ] **Step 4: Write `src/domain/translation/models.ts`**

```ts
export type GlossaryRule = "translate" | "transliterate" | "keep";

export interface GlossaryEntry {
  term: string;
  rule: GlossaryRule;
  target?: string;
  note?: string;
  updatedAt: string;
  source?: string;
}

export interface StyleGuide {
  text: string;
}

export interface Locale {
  dateFormat: string;
  numberFormat: string;
  currency: string;
  unit: string;
  honorific: string;
}

export interface FewShotExample {
  source: string;
  target: string;
  itemId?: string;
}

export type TranslationStatus = "translated" | "approved";

export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: TranslationStatus;
  translatedAt: string;
  approvedAt?: string;
}

export interface SharedContext {
  role: string;
  glossary: GlossaryEntry[];
  styleGuide: StyleGuide;
  locale: Locale;
  fewShots: FewShotExample[];
}
```

- [ ] **Step 5: Write `src/domain/translation/role.ts`**

```ts
/** Default translator persona (element ① of the 6-element prompt). Editable later. */
export const DEFAULT_ROLE =
  "당신은 크립토·Web3 씬을 깊이 이해하는 Mantle KR 전문 번역가입니다. " +
  "영어 원문을 한국 크립토 커뮤니티가 자연스럽게 읽는 한국어로 번역합니다. " +
  "아래 용어집·스타일 가이드·로케일·예시를 반드시 따르고, 어색한 번역투를 피합니다.";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/domain/translation/models.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/domain/translation tests/domain/translation/models.test.ts
git commit -m "feat: translation domain models, ContentItem, and default role"
```

---

## Task 2: Prompt assembler (pure)

**Files:**
- Create: `src/domain/translation/promptAssembler.ts`
- Test: `tests/domain/translation/promptAssembler.test.ts`

**Interfaces:**
- Consumes: `SharedContext`, `ContentItem` (Task 1)
- Produces:
  - `assembleSharedContext(ctx: SharedContext): string`
  - `assembleItemBlock(item: ContentItem, grounding?: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/translation/promptAssembler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleSharedContext, assembleItemBlock } from "../../../src/domain/translation/promptAssembler";
import type { SharedContext } from "../../../src/domain/translation/models";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const ctx: SharedContext = {
  role: "ROLE_TEXT",
  glossary: [
    { term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" },
    { term: "MNT", rule: "keep", note: "ticker", updatedAt: "2026-07-14" },
  ],
  styleGuide: { text: "STYLE_TEXT" },
  locale: { dateFormat: "YYYY년 M월 D일", numberFormat: "commas", currency: "USD", unit: "metric", honorific: "합니다체" },
  fewShots: [{ source: "Mantle mainnet", target: "맨틀 메인넷" }],
};

describe("assembleSharedContext", () => {
  it("includes role, each glossary term (with rule/target), style guide, locale, and few-shots — once", () => {
    const out = assembleSharedContext(ctx);
    expect(out).toContain("ROLE_TEXT");
    expect(out).toContain("Mantle");
    expect(out).toContain("transliterate");
    expect(out).toContain("맨틀");
    expect(out).toContain("MNT");
    expect(out).toContain("STYLE_TEXT");
    expect(out).toContain("합니다체");
    expect(out).toContain("Mantle mainnet");
    expect(out).toContain("맨틀 메인넷");
  });
});

describe("assembleItemBlock", () => {
  it("renders the item id, source text, and a translation marker", () => {
    const item: ContentItem = { id: "x:1", source: "x", text: "Hello Mantle", createdAt: "2026-01-01T00:00:00.000Z" };
    const out = assembleItemBlock(item);
    expect(out).toContain("x:1");
    expect(out).toContain("Hello Mantle");
    expect(out).toContain("번역:");
    expect(out).not.toContain("ROLE_TEXT"); // shared context is NOT repeated per item
  });

  it("includes grounding when provided", () => {
    const item: ContentItem = { id: "lark:9", source: "lark", text: "T", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(assembleItemBlock(item, "GROUND")).toContain("GROUND");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/translation/promptAssembler.test.ts`
Expected: FAIL — cannot resolve `promptAssembler`.

- [ ] **Step 3: Write `src/domain/translation/promptAssembler.ts`**

```ts
import type { ContentItem } from "./contentItem";
import type { GlossaryEntry, Locale, SharedContext } from "./models";

function renderGlossaryEntry(e: GlossaryEntry): string {
  const target = e.target ? `: ${e.target}` : "";
  const note = e.note ? ` (${e.note})` : "";
  return `- ${e.term} → ${e.rule}${target}${note}`;
}

function renderLocale(l: Locale): string {
  return [
    `- 날짜: ${l.dateFormat}`,
    `- 숫자: ${l.numberFormat}`,
    `- 통화: ${l.currency}`,
    `- 단위: ${l.unit}`,
    `- 존대: ${l.honorific}`,
  ].join("\n");
}

/** Element ①②③④⑤ assembled once per batch (never repeated per item). */
export function assembleSharedContext(ctx: SharedContext): string {
  const glossary = ctx.glossary.map(renderGlossaryEntry).join("\n");
  const fewShots = ctx.fewShots
    .map((f) => `- EN: ${f.source}\n  KO: ${f.target}`)
    .join("\n");
  return [
    "# Mantle KR 번역 작업",
    "",
    "## ① 역할",
    ctx.role,
    "",
    "## ② 용어집 (Glossary)",
    glossary,
    "",
    "## ③ 스타일 가이드",
    ctx.styleGuide.text,
    "",
    "## ④ 로케일",
    renderLocale(ctx.locale),
    "",
    "## ⑤ 예시 (Few-shot)",
    fewShots,
    "",
    "---",
    "아래 각 아이템의 `원문:`을 위 규칙에 따라 번역해 `번역:` 아래에 채워 주세요.",
    "",
  ].join("\n");
}

/** Per-item block: content (+ optional ⑥ grounding). No shared context here. */
export function assembleItemBlock(item: ContentItem, grounding?: string): string {
  const lines = [`### ${item.id}`, "원문:", item.text];
  if (grounding && grounding.length > 0) {
    lines.push("⑥ 근거(grounding):", grounding);
  }
  lines.push("번역:", "");
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/domain/translation/promptAssembler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/translation/promptAssembler.ts tests/domain/translation/promptAssembler.test.ts
git commit -m "feat: pure prompt assembler (shared context once + per-item block)"
```

---

## Task 3: Translation ports

**Files:**
- Create: `src/ports/ContentSource.ts`, `src/ports/GlossaryStore.ts`, `src/ports/FewShotStore.ts`, `src/ports/TranslationStore.ts`, `src/ports/TranslationConfig.ts`

**Interfaces:**
- Consumes: `ContentItem` (Task 1), `GlossaryEntry`, `FewShotExample`, `Translation`, `StyleGuide`, `Locale` (Task 1)
- Produces:
  - `ContentSource.loadPending(translatedIds: Set<string>): Promise<ContentItem[]>`
  - `GlossaryStore.load(): Promise<GlossaryEntry[]>` / `upsertEntry(entry: GlossaryEntry): Promise<void>`
  - `FewShotStore.load(): Promise<FewShotExample[]>` / `add(ex: FewShotExample): Promise<void>`
  - `TranslationStore.loadAll(): Promise<Translation[]>` / `upsert(t: Translation): Promise<void>` / `listTranslatedIds(): Promise<Set<string>>`
  - `TranslationConfig.loadStyleGuide(): Promise<StyleGuide>` / `loadLocale(): Promise<Locale>`

- [ ] **Step 1: Write `src/ports/ContentSource.ts`**

```ts
import type { ContentItem } from "../domain/translation/contentItem";

export interface ContentSource {
  /** Collected items not yet translated (id not in translatedIds). */
  loadPending(translatedIds: Set<string>): Promise<ContentItem[]>;
}
```

- [ ] **Step 2: Write `src/ports/GlossaryStore.ts`**

```ts
import type { GlossaryEntry } from "../domain/translation/models";

export interface GlossaryStore {
  load(): Promise<GlossaryEntry[]>;
  /** Insert or replace by term. */
  upsertEntry(entry: GlossaryEntry): Promise<void>;
}
```

- [ ] **Step 3: Write `src/ports/FewShotStore.ts`**

```ts
import type { FewShotExample } from "../domain/translation/models";

export interface FewShotStore {
  load(): Promise<FewShotExample[]>;
  add(ex: FewShotExample): Promise<void>;
}
```

- [ ] **Step 4: Write `src/ports/TranslationStore.ts`**

```ts
import type { Translation } from "../domain/translation/models";

export interface TranslationStore {
  loadAll(): Promise<Translation[]>;
  upsert(t: Translation): Promise<void>; // by itemId
  listTranslatedIds(): Promise<Set<string>>;
}
```

- [ ] **Step 5: Write `src/ports/TranslationConfig.ts`**

```ts
import type { Locale, StyleGuide } from "../domain/translation/models";

export interface TranslationConfig {
  loadStyleGuide(): Promise<StyleGuide>;
  loadLocale(): Promise<Locale>;
}
```

- [ ] **Step 6: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/ports/ContentSource.ts src/ports/GlossaryStore.ts src/ports/FewShotStore.ts src/ports/TranslationStore.ts src/ports/TranslationConfig.ts
git commit -m "feat: translation ports (ContentSource, GlossaryStore, FewShotStore, TranslationStore, TranslationConfig)"
```

---

## Task 4: Content sources (X, Lark, composite)

**Files:**
- Create: `src/adapters/content/XContentSource.ts`, `src/adapters/content/LarkContentSource.ts`, `src/adapters/content/CompositeContentSource.ts`
- Test: `tests/adapters/content/contentSources.test.ts`

**Interfaces:**
- Consumes: `ContentSource` (Task 3), `ContentItem` (Task 1), `CollectedThread` (`src/domain/models.ts`), `LarkMessage` (`src/domain/larkMessage.ts`), `readJsonFile` (`src/shared/store/jsonFile.ts`)
- Produces:
  - `XContentSource(itemsPath: string) implements ContentSource`
  - `LarkContentSource(itemsPath: string) implements ContentSource`
  - `CompositeContentSource(sources: ContentSource[]) implements ContentSource`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/content/contentSources.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XContentSource } from "../../../src/adapters/content/XContentSource";
import { LarkContentSource } from "../../../src/adapters/content/LarkContentSource";
import { CompositeContentSource } from "../../../src/adapters/content/CompositeContentSource";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "content-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("XContentSource", () => {
  it("maps active threads to ContentItem (joined text, x: id) and excludes translated + deleted", async () => {
    const items = [
      {
        rootId: "100", status: "active", firstSeenAt: "2026-01-01T00:00:00.000Z",
        tweets: [
          { id: "100", conversationId: "100", text: "Line A", createdAt: "2026-01-01T00:01:00.000Z", url: "u/100", authorUserName: "Mantle_Official", isReply: false, isQuote: false },
          { id: "101", conversationId: "100", text: "Line B", createdAt: "2026-01-01T00:02:00.000Z", url: "u/101", authorUserName: "Mantle_Official", isReply: true, isQuote: false },
        ],
      },
      { rootId: "200", status: "deleted", firstSeenAt: "x", tweets: [{ id: "200", conversationId: "200", text: "gone", createdAt: "2026-01-01T00:00:00.000Z", url: "u", authorUserName: "Mantle_Official", isReply: false, isQuote: false }] },
    ];
    const path = join(dir, "items.json");
    await writeFile(path, JSON.stringify(items), "utf8");

    const pending = await new XContentSource(path).loadPending(new Set(["x:999"]));

    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("x:100");
    expect(pending[0].source).toBe("x");
    expect(pending[0].text).toContain("Line A");
    expect(pending[0].text).toContain("Line B");
    expect(pending[0].refUrl).toBe("u/100");
  });

  it("excludes already-translated threads", async () => {
    const items = [{ rootId: "100", status: "active", firstSeenAt: "x", tweets: [{ id: "100", conversationId: "100", text: "t", createdAt: "2026-01-01T00:00:00.000Z", url: "u", authorUserName: "a", isReply: false, isQuote: false }] }];
    await writeFile(join(dir, "items.json"), JSON.stringify(items), "utf8");
    const pending = await new XContentSource(join(dir, "items.json")).loadPending(new Set(["x:100"]));
    expect(pending).toHaveLength(0);
  });

  it("returns [] when the file is absent", async () => {
    const pending = await new XContentSource(join(dir, "missing.json")).loadPending(new Set());
    expect(pending).toEqual([]);
  });
});

describe("LarkContentSource", () => {
  it("maps messages to ContentItem (lark: id) and excludes translated", async () => {
    const msgs = [
      { messageId: "om_1", chatId: "oc", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z", text: "안녕 Mantle", rawContent: "{}" },
      { messageId: "om_2", chatId: "oc", msgType: "post", createdAt: "2026-01-02T00:00:00.000Z", text: "post text", rawContent: "{}" },
    ];
    await writeFile(join(dir, "lark-items.json"), JSON.stringify(msgs), "utf8");
    const pending = await new LarkContentSource(join(dir, "lark-items.json")).loadPending(new Set(["lark:om_2"]));
    expect(pending.map((p) => p.id)).toEqual(["lark:om_1"]);
    expect(pending[0].source).toBe("lark");
    expect(pending[0].text).toBe("안녕 Mantle");
  });
});

describe("CompositeContentSource", () => {
  it("concatenates pending from all sources", async () => {
    const a: ContentItem[] = [{ id: "x:1", source: "x", text: "a", createdAt: "2026-01-01T00:00:00.000Z" }];
    const b: ContentItem[] = [{ id: "lark:1", source: "lark", text: "b", createdAt: "2026-01-02T00:00:00.000Z" }];
    const composite = new CompositeContentSource([
      { loadPending: async () => a },
      { loadPending: async () => b },
    ]);
    const pending = await composite.loadPending(new Set());
    expect(pending.map((p) => p.id)).toEqual(["x:1", "lark:1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/content/contentSources.test.ts`
Expected: FAIL — cannot resolve the sources.

- [ ] **Step 3: Write `src/adapters/content/XContentSource.ts`**

```ts
import type { CollectedThread } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

export class XContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const threads = await readJsonFile<CollectedThread[]>(this.itemsPath, []);
    const items: ContentItem[] = [];
    for (const thread of threads) {
      if (thread.status !== "active") continue;
      const id = `x:${thread.rootId}`;
      if (translatedIds.has(id)) continue;
      const first = thread.tweets[0];
      items.push({
        id,
        source: "x",
        text: thread.tweets.map((t) => t.text).join("\n\n"),
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
      });
    }
    return items;
  }
}
```

- [ ] **Step 4: Write `src/adapters/content/LarkContentSource.ts`**

```ts
import type { LarkMessage } from "../../domain/larkMessage";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

export class LarkContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const messages = await readJsonFile<LarkMessage[]>(this.itemsPath, []);
    const items: ContentItem[] = [];
    for (const m of messages) {
      const id = `lark:${m.messageId}`;
      if (translatedIds.has(id)) continue;
      items.push({ id, source: "lark", text: m.text, createdAt: m.createdAt });
    }
    return items;
  }
}
```

- [ ] **Step 5: Write `src/adapters/content/CompositeContentSource.ts`**

```ts
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";

export class CompositeContentSource implements ContentSource {
  constructor(private readonly sources: ContentSource[]) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const all: ContentItem[] = [];
    for (const source of this.sources) {
      all.push(...(await source.loadPending(translatedIds)));
    }
    return all;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/adapters/content/contentSources.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/content tests/adapters/content/contentSources.test.ts
git commit -m "feat: X/Lark/composite content sources → ContentItem"
```

---

## Task 5: JSON stores + file config

**Files:**
- Create: `src/adapters/store/JsonGlossaryStore.ts`, `src/adapters/store/JsonFewShotStore.ts`, `src/adapters/store/JsonTranslationStore.ts`, `src/adapters/store/FileTranslationConfig.ts`
- Test: `tests/adapters/store/translationStores.test.ts`

**Interfaces:**
- Consumes: ports (Task 3), models (Task 1), `readJsonFile`/`writeJsonFileAtomic` (`src/shared/store/jsonFile.ts`)
- Produces:
  - `JsonGlossaryStore(dir: string)` (reads/writes `<dir>/glossary.json`) `implements GlossaryStore`
  - `JsonFewShotStore(dir: string)` (`<dir>/few-shot.json`) `implements FewShotStore`
  - `JsonTranslationStore(dir: string)` (`<dir>/translations.json`) `implements TranslationStore`
  - `FileTranslationConfig(dir: string)` (`<dir>/style-guide.md`, `<dir>/locale.json`) `implements TranslationConfig`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/store/translationStores.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonGlossaryStore } from "../../../src/adapters/store/JsonGlossaryStore";
import { JsonFewShotStore } from "../../../src/adapters/store/JsonFewShotStore";
import { JsonTranslationStore } from "../../../src/adapters/store/JsonTranslationStore";
import { FileTranslationConfig } from "../../../src/adapters/store/FileTranslationConfig";
import type { Translation } from "../../../src/domain/translation/models";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tstore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function translation(itemId: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId, source: "x", sourceText: "s", koreanText: "ko",
    status: over.status ?? "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("JsonGlossaryStore", () => {
  it("upsertEntry replaces by term; load returns all", async () => {
    const store = new JsonGlossaryStore(dir);
    await store.upsertEntry({ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" });
    await store.upsertEntry({ term: "Mantle", rule: "transliterate", target: "맨틀넷", updatedAt: "2026-07-15" });
    const all = await store.load();
    expect(all).toHaveLength(1);
    expect(all[0].target).toBe("맨틀넷");
  });
});

describe("JsonFewShotStore", () => {
  it("add appends; load returns all", async () => {
    const store = new JsonFewShotStore(dir);
    await store.add({ source: "a", target: "가" });
    await store.add({ source: "b", target: "나" });
    expect(await store.load()).toHaveLength(2);
  });
});

describe("JsonTranslationStore", () => {
  it("upsert by itemId; listTranslatedIds returns the id set", async () => {
    const store = new JsonTranslationStore(dir);
    await store.upsert(translation("x:1", { koreanText: "old" }));
    await store.upsert(translation("x:1", { koreanText: "new" }));
    await store.upsert(translation("lark:2"));
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.itemId === "x:1")?.koreanText).toBe("new");
    expect([...(await store.listTranslatedIds())].sort()).toEqual(["lark:2", "x:1"]);
  });
});

describe("FileTranslationConfig", () => {
  it("loads style guide text and locale json", async () => {
    await writeFile(join(dir, "style-guide.md"), "# Style\nBe concise.", "utf8");
    await writeFile(join(dir, "locale.json"), JSON.stringify({ dateFormat: "d", numberFormat: "n", currency: "USD", unit: "m", honorific: "합니다체" }), "utf8");
    const config = new FileTranslationConfig(dir);
    expect((await config.loadStyleGuide()).text).toContain("Be concise");
    expect((await config.loadLocale()).honorific).toBe("합니다체");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/store/translationStores.test.ts`
Expected: FAIL — cannot resolve the stores.

- [ ] **Step 3: Write `src/adapters/store/JsonGlossaryStore.ts`**

```ts
import { join } from "node:path";
import type { GlossaryEntry } from "../../domain/translation/models";
import type { GlossaryStore } from "../../ports/GlossaryStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonGlossaryStore implements GlossaryStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "glossary.json");
  }
  async load(): Promise<GlossaryEntry[]> {
    return readJsonFile<GlossaryEntry[]>(this.path, []);
  }
  async upsertEntry(entry: GlossaryEntry): Promise<void> {
    const all = await this.load();
    const byTerm = new Map(all.map((e) => [e.term, e]));
    byTerm.set(entry.term, entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byTerm.values()]);
  }
}
```

- [ ] **Step 4: Write `src/adapters/store/JsonFewShotStore.ts`**

```ts
import { join } from "node:path";
import type { FewShotExample } from "../../domain/translation/models";
import type { FewShotStore } from "../../ports/FewShotStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonFewShotStore implements FewShotStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "few-shot.json");
  }
  async load(): Promise<FewShotExample[]> {
    return readJsonFile<FewShotExample[]>(this.path, []);
  }
  async add(ex: FewShotExample): Promise<void> {
    const all = await this.load();
    all.push(ex);
    await writeJsonFileAtomic(this.dir, this.path, all);
  }
}
```

- [ ] **Step 5: Write `src/adapters/store/JsonTranslationStore.ts`**

```ts
import { join } from "node:path";
import type { Translation } from "../../domain/translation/models";
import type { TranslationStore } from "../../ports/TranslationStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonTranslationStore implements TranslationStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "translations.json");
  }
  async loadAll(): Promise<Translation[]> {
    return readJsonFile<Translation[]>(this.path, []);
  }
  async upsert(t: Translation): Promise<void> {
    const all = await this.loadAll();
    const byId = new Map(all.map((x) => [x.itemId, x]));
    byId.set(t.itemId, t);
    await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
  }
  async listTranslatedIds(): Promise<Set<string>> {
    const all = await this.loadAll();
    return new Set(all.map((t) => t.itemId));
  }
}
```

- [ ] **Step 6: Write `src/adapters/store/FileTranslationConfig.ts`**

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locale, StyleGuide } from "../../domain/translation/models";
import type { TranslationConfig } from "../../ports/TranslationConfig";
import { readJsonFile } from "../../shared/store/jsonFile";

const DEFAULT_LOCALE: Locale = {
  dateFormat: "YYYY년 M월 D일",
  numberFormat: "천 단위 콤마",
  currency: "USD",
  unit: "미터법",
  honorific: "합니다체",
};

export class FileTranslationConfig implements TranslationConfig {
  constructor(private readonly dir: string) {}

  async loadStyleGuide(): Promise<StyleGuide> {
    try {
      return { text: await readFile(join(this.dir, "style-guide.md"), "utf8") };
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "" };
      }
      throw err;
    }
  }

  async loadLocale(): Promise<Locale> {
    return readJsonFile<Locale>(join(this.dir, "locale.json"), DEFAULT_LOCALE);
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm test tests/adapters/store/translationStores.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/adapters/store/JsonGlossaryStore.ts src/adapters/store/JsonFewShotStore.ts src/adapters/store/JsonTranslationStore.ts src/adapters/store/FileTranslationConfig.ts tests/adapters/store/translationStores.test.ts
git commit -m "feat: JSON glossary/few-shot/translation stores + file translation config"
```

---

## Task 6: PrepareTranslations use-case

**Files:**
- Create: `src/app/PrepareTranslations.ts`
- Test: `tests/app/prepareTranslations.test.ts`

**Interfaces:**
- Consumes: ports (Task 3), `assembleSharedContext`/`assembleItemBlock` (Task 2), `DEFAULT_ROLE` (Task 1), `ContentItem`
- Produces: `PrepareTranslations(source, glossaryStore, fewShotStore, config, translationStore, role = DEFAULT_ROLE)`; `run(selector: Selector): Promise<{ worksheet: string; pending: ContentItem[] }>`; `Selector { ids?: string[]; since?: string; limit?: number }` (default limit 20).

- [ ] **Step 1: Write the failing test**

Create `tests/app/prepareTranslations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PrepareTranslations } from "../../src/app/PrepareTranslations";
import type { ContentSource } from "../../src/ports/ContentSource";
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { TranslationConfig } from "../../src/ports/TranslationConfig";
import type { ContentItem } from "../../src/domain/translation/contentItem";

function item(id: string, createdAt: string): ContentItem {
  return { id, source: id.startsWith("x") ? "x" : "lark", text: `text-${id}`, createdAt };
}

function deps(pending: ContentItem[], translated: string[] = []) {
  const source: ContentSource = { loadPending: async (ids) => pending.filter((p) => !ids.has(p.id)) };
  const glossaryStore: GlossaryStore = { load: async () => [{ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" }], upsertEntry: async () => {} };
  const fewShotStore: FewShotStore = { load: async () => [], add: async () => {} };
  const config: TranslationConfig = { loadStyleGuide: async () => ({ text: "STYLE" }), loadLocale: async () => ({ dateFormat: "d", numberFormat: "n", currency: "USD", unit: "m", honorific: "합니다체" }) };
  const translationStore: TranslationStore = { loadAll: async () => [], upsert: async () => {}, listTranslatedIds: async () => new Set(translated) };
  return { source, glossaryStore, fewShotStore, config, translationStore };
}

describe("PrepareTranslations", () => {
  it("assembles a worksheet with one shared context + a block per pending item", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("lark:2", "2026-01-02T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, "ROLE");
    const { worksheet, pending } = await uc.run({});
    expect(pending.map((p) => p.id)).toEqual(["x:1", "lark:2"]);
    expect(worksheet.match(/## ① 역할/g)).toHaveLength(1); // shared context once
    expect(worksheet).toContain("ROLE");
    expect(worksheet).toContain("text-x:1");
    expect(worksheet).toContain("text-lark:2");
  });

  it("excludes already-translated ids and applies the limit", async () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`x:${i}`, "2026-01-01T00:00:00.000Z"));
    const d = deps(items, ["x:0"]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore);
    const { pending } = await uc.run({ limit: 5 });
    expect(pending).toHaveLength(5);
    expect(pending.some((p) => p.id === "x:0")).toBe(false);
  });

  it("filters by ids and since when given", async () => {
    const d = deps([item("x:1", "2026-01-01T00:00:00.000Z"), item("x:2", "2026-06-01T00:00:00.000Z")]);
    const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore);
    expect((await uc.run({ ids: ["x:2"] })).pending.map((p) => p.id)).toEqual(["x:2"]);
    expect((await uc.run({ since: "2026-03-01T00:00:00.000Z" })).pending.map((p) => p.id)).toEqual(["x:2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/prepareTranslations.test.ts`
Expected: FAIL — cannot resolve `PrepareTranslations`.

- [ ] **Step 3: Write `src/app/PrepareTranslations.ts`**

```ts
import { DEFAULT_ROLE } from "../domain/translation/role";
import { assembleItemBlock, assembleSharedContext } from "../domain/translation/promptAssembler";
import type { ContentItem } from "../domain/translation/contentItem";
import type { ContentSource } from "../ports/ContentSource";
import type { GlossaryStore } from "../ports/GlossaryStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { TranslationStore } from "../ports/TranslationStore";
import type { TranslationConfig } from "../ports/TranslationConfig";

export interface Selector {
  ids?: string[];
  since?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;

export class PrepareTranslations {
  constructor(
    private readonly source: ContentSource,
    private readonly glossaryStore: GlossaryStore,
    private readonly fewShotStore: FewShotStore,
    private readonly config: TranslationConfig,
    private readonly translationStore: TranslationStore,
    private readonly role: string = DEFAULT_ROLE,
  ) {}

  async run(selector: Selector): Promise<{ worksheet: string; pending: ContentItem[] }> {
    const translatedIds = await this.translationStore.listTranslatedIds();
    let pending = await this.source.loadPending(translatedIds);
    pending = this.applySelector(pending, selector);

    const [glossary, styleGuide, locale, fewShots] = await Promise.all([
      this.glossaryStore.load(),
      this.config.loadStyleGuide(),
      this.config.loadLocale(),
      this.fewShotStore.load(),
    ]);

    const header = assembleSharedContext({ role: this.role, glossary, styleGuide, locale, fewShots });
    const blocks = pending.map((item) => assembleItemBlock(item));
    const worksheet = [header, ...blocks].join("\n");

    return { worksheet, pending };
  }

  private applySelector(items: ContentItem[], selector: Selector): ContentItem[] {
    let result = items;
    if (selector.ids && selector.ids.length > 0) {
      const wanted = new Set(selector.ids);
      result = result.filter((i) => wanted.has(i.id));
    }
    if (selector.since) {
      const since = selector.since;
      result = result.filter((i) => i.createdAt >= since);
    }
    const limit = selector.limit ?? DEFAULT_LIMIT;
    return result.slice(0, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/prepareTranslations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/PrepareTranslations.ts tests/app/prepareTranslations.test.ts
git commit -m "feat: PrepareTranslations use-case (bounded selector + shared-context worksheet)"
```

---

## Task 7: SaveTranslation use-case

**Files:**
- Create: `src/app/SaveTranslation.ts`
- Test: `tests/app/saveTranslation.test.ts`

**Interfaces:**
- Consumes: `TranslationStore`, `FewShotStore` (Task 3), `Translation` (Task 1)
- Produces: `SaveTranslation(translationStore, fewShotStore, now = () => new Date().toISOString())`; `run(input: SaveInput): Promise<{ itemId: string; promoted: boolean }>`; `SaveInput { itemId: string; source: "x"|"lark"; sourceText: string; koreanText: string; approve: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/app/saveTranslation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SaveTranslation } from "../../src/app/SaveTranslation";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { Translation, FewShotExample } from "../../src/domain/translation/models";

function stores() {
  const saved: Translation[] = [];
  const fewShots: FewShotExample[] = [];
  const translationStore: TranslationStore = {
    loadAll: async () => saved,
    upsert: async (t) => { saved.push(t); },
    listTranslatedIds: async () => new Set(saved.map((t) => t.itemId)),
  };
  const fewShotStore: FewShotStore = { load: async () => fewShots, add: async (ex) => { fewShots.push(ex); } };
  return { saved, fewShots, translationStore, fewShotStore };
}

describe("SaveTranslation", () => {
  it("stores a translation with status 'translated' and does not promote when not approved", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: false });
    expect(res).toEqual({ itemId: "x:1", promoted: false });
    expect(s.saved[0].status).toBe("translated");
    expect(s.saved[0].translatedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(s.fewShots).toHaveLength(0);
  });

  it("marks approved and promotes to few-shot when approved", async () => {
    const s = stores();
    const uc = new SaveTranslation(s.translationStore, s.fewShotStore, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", source: "x", sourceText: "hi", koreanText: "안녕", approve: true });
    expect(res.promoted).toBe(true);
    expect(s.saved[0].status).toBe("approved");
    expect(s.saved[0].approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(s.fewShots).toEqual([{ source: "hi", target: "안녕", itemId: "x:1" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/saveTranslation.test.ts`
Expected: FAIL — cannot resolve `SaveTranslation`.

- [ ] **Step 3: Write `src/app/SaveTranslation.ts`**

```ts
import type { Translation } from "../domain/translation/models";
import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";

export interface SaveInput {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  approve: boolean;
}

export class SaveTranslation {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly fewShotStore: FewShotStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SaveInput): Promise<{ itemId: string; promoted: boolean }> {
    const timestamp = this.now();
    const translation: Translation = {
      itemId: input.itemId,
      source: input.source,
      sourceText: input.sourceText,
      koreanText: input.koreanText,
      status: input.approve ? "approved" : "translated",
      translatedAt: timestamp,
      approvedAt: input.approve ? timestamp : undefined,
    };
    await this.translationStore.upsert(translation);

    if (input.approve) {
      await this.fewShotStore.add({ source: input.sourceText, target: input.koreanText, itemId: input.itemId });
    }
    return { itemId: input.itemId, promoted: input.approve };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/saveTranslation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/SaveTranslation.ts tests/app/saveTranslation.test.ts
git commit -m "feat: SaveTranslation use-case (ingest + approved→few-shot promotion)"
```

---

## Task 8: CLIs + scripts + README

**Files:**
- Create: `src/cli/translate-prepare.ts`, `src/cli/translate-save.ts`, `src/cli/glossary.ts`
- Modify: `package.json` (scripts), `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: `pnpm translate:prepare`, `pnpm translate:save`, `pnpm glossary`

- [ ] **Step 1: Write `src/cli/translate-prepare.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { PrepareTranslations, type Selector } from "../app/PrepareTranslations";
import type { ContentSource } from "../ports/ContentSource";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sourceArg = argValue("--source"); // "x" | "lark" | undefined (both)
const xSource = new XContentSource("output/items.json");
const larkSource = new LarkContentSource("output/lark-items.json");
const source: ContentSource =
  sourceArg === "x" ? xSource : sourceArg === "lark" ? larkSource : new CompositeContentSource([xSource, larkSource]);

const selector: Selector = {};
const ids = argValue("--ids");
if (ids) selector.ids = ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const since = argValue("--since");
if (since) selector.since = since;
const limit = argValue("--limit");
if (limit) selector.limit = Number(limit);

const usecase = new PrepareTranslations(
  source,
  new JsonGlossaryStore("data"),
  new JsonFewShotStore("data"),
  new FileTranslationConfig("data"),
  new JsonTranslationStore("output"),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir("output", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join("output", `translation-batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(
  join("output", "translation-pending.json"),
  `${JSON.stringify(pending, null, 2)}\n`,
  "utf8",
);

console.log(`prepared ${pending.length} item(s) → ${worksheetPath}`);
console.log("Translate each item's 원문 into the 번역 section, then run: pnpm translate:save --id <id> --file <korean.txt> [--approve]");
```

- [ ] **Step 2: Write `src/cli/translate-save.ts`**

```ts
import { readFile } from "node:fs/promises";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { readJsonFile } from "../shared/store/jsonFile";
import type { ContentItem } from "../domain/translation/contentItem";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = argValue("--id");
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !file) {
  throw new Error("Usage: pnpm translate:save --id <itemId> --file <korean.txt> [--approve]");
}

const pending = await readJsonFile<ContentItem[]>("output/translation-pending.json", []);
const item = pending.find((p) => p.id === id);
if (!item) {
  throw new Error(`Item ${id} not found in output/translation-pending.json (run translate:prepare first)`);
}

const koreanText = (await readFile(file, "utf8")).trim();

const usecase = new SaveTranslation(new JsonTranslationStore("output"), new JsonFewShotStore("data"));
const res = await usecase.run({
  itemId: item.id,
  source: item.source,
  sourceText: item.text,
  koreanText,
  approve,
});

console.log(`saved ${res.itemId}${res.promoted ? " (approved → few-shot)" : ""}`);
```

- [ ] **Step 3: Write `src/cli/glossary.ts`**

```ts
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import type { GlossaryRule } from "../domain/translation/models";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const store = new JsonGlossaryStore("data");
const command = process.argv[2];

if (command === "add") {
  const term = argValue("--term");
  const rule = argValue("--rule") as GlossaryRule | undefined;
  if (!term || !rule) {
    throw new Error('Usage: pnpm glossary add --term <term> --rule <translate|transliterate|keep> [--target <ko>] [--note <n>] [--source <url>]');
  }
  await store.upsertEntry({
    term,
    rule,
    target: argValue("--target"),
    note: argValue("--note"),
    source: argValue("--source"),
    updatedAt: new Date().toISOString().slice(0, 10),
  });
  console.log(`glossary: upserted "${term}"`);
} else {
  const all = await store.load();
  console.log(`glossary: ${all.length} entries`);
  for (const e of all) {
    console.log(`  ${e.term} → ${e.rule}${e.target ? ": " + e.target : ""}`);
  }
}
```

- [ ] **Step 4: Add scripts to `package.json`**

In the `"scripts"` block add:
```json
    "translate:prepare": "tsx src/cli/translate-prepare.ts",
    "translate:save": "tsx src/cli/translate-save.ts",
    "glossary": "tsx src/cli/glossary.ts",
```

- [ ] **Step 5: Verify typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck exit 0; all tests pass (no probes added here).

- [ ] **Step 6: Update `README.md`**

Add a section after the Lark section:

```markdown
## Module C — Korean translation (agent-assisted)

Assembles 6-element translation prompts from collected X/Lark content (shared context once per batch + per-item text) and stores agent-produced Korean translations, with a few-shot flywheel. The local Claude agent does the actual translation — no Claude API.

### Data

Living config in `data/` (git-tracked): `glossary.json`, `style-guide.md`, `locale.json`, `few-shot.json`. Edit these to steer tone/terminology.

### Commands

```bash
pnpm translate:prepare [--source x|lark] [--ids a,b] [--since <ISO>] [--limit 20]
#   → writes output/translation-batch-<ts>.md (worksheet) + output/translation-pending.json
#   → the agent translates each item's 원문 into its 번역 section
pnpm translate:save --id <itemId> --file <korean.txt> [--approve]   # ingest; --approve promotes to few-shot
pnpm glossary                                                       # list entries
pnpm glossary add --term <t> --rule <translate|transliterate|keep> [--target <ko>] [--source <url>]
```

Worksheets/translations are written to `output/` (git-ignored).
```

- [ ] **Step 7: Commit**

```bash
git add src/cli/translate-prepare.ts src/cli/translate-save.ts src/cli/glossary.ts package.json README.md
git commit -m "feat: translate:prepare/save + glossary CLIs and README"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** ContentItem unification (§2/§4) → Tasks 1/4; 6-element prompt with shared-context-once (§4/§5) → Tasks 1/2/6; ports (§6) → Task 3; content readers of A/B output (§3) → Task 4; glossary/few-shot/translation stores + config (§3/§10) → Task 5; PrepareTranslations bounded selector (§7-1) → Task 6; SaveTranslation + few-shot promotion (§7-2/§5) → Task 7; CLIs incl. glossary web-research channel (§7-3/§12) → Task 8; no API/secrets (§9) → honored. Data seeds already committed.
- **Placeholder scan:** every code/test step has complete code + exact commands. No TBD/TODO.
- **Type consistency:** `ContentItem`, `Translation`, `SharedContext`, `Selector`, `SaveInput`, and all port signatures are defined once (Tasks 1/3/6/7) and consumed with matching names/types across tasks. `loadPending(Set)`, `listTranslatedIds():Set`, `upsertEntry`/`add`/`upsert`, `assembleSharedContext`/`assembleItemBlock` match producer↔consumer.

## Notes / Deferred (out of scope for subsystem C)

- Automated translation: add a `Translator` port + `ClaudeApiTranslator` adapter reusing the assembled prompt.
- §5 item conversion (KOL brief / PR): separate subsystem, same assembly pattern.
- Drive upload (D): new `TranslationStore` adapter or exporter.
- Glossary web research is agent-driven (WebSearch) writing via `pnpm glossary add`; not a coded fetch.
