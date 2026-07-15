# Second Review (§7) — Dashboard extension for channel renderings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **2차 검수** mode to the existing review dashboard so a human can list, filter, edit, and approve the §6 channel renderings (the copy-paste-ready channel text) before §8 upload.

**Architecture:** Extend the E dashboard's thin-adapter pattern. `ChannelRendering` gains an approval `status` (mirroring `Translation`/`ContentVariant`); `apiHandlers` gets `/api/renderings` routes over `FormattingStore` + the existing `SaveRendering` + a new `ApproveRendering`; the React frontend gets a header mode toggle and a new list/detail view. No new domain logic beyond the model field. §8 upload is out of scope.

**Tech Stack:** TypeScript ESM (`moduleResolution: bundler`, no `.js` suffixes), `node:http`, React 18 + Vite 5 + Tailwind v4 (build-time devDeps), vitest, tsx, zod-only runtime.

## Global Constraints

- Code and comments in English; user-facing UI copy may be Korean (match existing dashboard copy).
- Runtime dependencies stay **zod-only**; React/Vite/Tailwind stay build-time devDeps.
- ESM imports have **no file extension**.
- Backend follows the existing thin-adapter pattern: `apiHandlers` routes over app use-cases, `HttpServer` unchanged, `serve.ts` is the composition root.
- Rendering identity is `(itemId, type, channel)`; the URL encodes `itemId` (contains `:`).
- Editing a rendering reverts it to `status: "rendered"` (must be re-approved), exactly as editing a translation reverts it to `translated`.
- Existing translation review flow (§4) must keep working unchanged.

---

## File Structure

**Backend**
- Modify: `src/domain/formatting/models.ts` — add `status` + `approvedAt` to `ChannelRendering`.
- Modify: `src/app/FormatVariants.ts` — created renderings carry `status: "rendered"`.
- Modify: `src/app/SaveRendering.ts` — created/edited renderings carry `status: "rendered"`.
- Create: `src/app/ApproveRendering.ts` — approve use-case.
- Modify: `src/adapters/web/apiHandlers.ts` — `ApiDeps` + `/api/renderings` routes.
- Modify: `src/cli/serve.ts` — wire the new deps.

**Frontend (`web/`)**
- Modify: `web/src/types.ts` — `Rendering` type.
- Modify: `web/src/api.ts` — rendering endpoints.
- Modify: `web/src/App.tsx` — mode toggle + conditional view.
- Create: `web/src/components/RenderingsView.tsx`, `RenderingList.tsx`, `RenderingDetail.tsx`.

**Tests**
- Modify: `tests/app/SaveRendering.test.ts`, `tests/adapters/store/JsonFormattingStore.test.ts` (new model field).
- Create: `tests/app/ApproveRendering.test.ts`.
- Modify: `tests/adapters/web/apiHandlers.test.ts` (deps + rendering routes).

---

## Task 1: Model field + F creators + affected F tests

**Files:**
- Modify: `src/domain/formatting/models.ts`
- Modify: `src/app/FormatVariants.ts`
- Modify: `src/app/SaveRendering.ts`
- Modify: `tests/app/SaveRendering.test.ts`
- Modify: `tests/adapters/store/JsonFormattingStore.test.ts`

**Interfaces:**
- Produces: `ChannelRendering` now has `status: "rendered" | "approved"` and `approvedAt?: string`. Both `FormatVariants` and `SaveRendering` set `status: "rendered"` on creation.

- [ ] **Step 1: Add the fields to the model**

In `src/domain/formatting/models.ts`, replace the `ChannelRendering` interface:

```ts
/** One converted variant formatted for a specific channel. Identity is (itemId, type, channel). */
export interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean; // false = code formatter only; true = agent/human edited
  createdAt: string;
  status: "rendered" | "approved"; // §7 second-review approval gate
  approvedAt?: string;
}
```

- [ ] **Step 2: Set `status: "rendered"` in `FormatVariants`**

In `src/app/FormatVariants.ts`, the `rendering` object literal in `run()` currently is:

```ts
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text: result.text, refined: false, createdAt: this.now(),
        };
```

Replace with:

```ts
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text: result.text, refined: false, createdAt: this.now(), status: "rendered",
        };
```

- [ ] **Step 3: Set `status: "rendered"` in `SaveRendering`**

In `src/app/SaveRendering.ts`, the `rendering` object literal is:

```ts
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, createdAt: this.now(),
    };
```

Replace with:

```ts
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, createdAt: this.now(), status: "rendered",
    };
```

- [ ] **Step 4: Update the two affected tests**

In `tests/app/SaveRendering.test.ts`, the full-object assertion (line ~13) is:

```ts
    expect(saved[0]).toEqual({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트", refined: true, createdAt: "2026-04-04T00:00:00.000Z" });
```

Replace with:

```ts
    expect(saved[0]).toEqual({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트", refined: true, createdAt: "2026-04-04T00:00:00.000Z", status: "rendered" });
```

In `tests/adapters/store/JsonFormattingStore.test.ts`, the fixture is:

```ts
function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "2026-01-01T00:00:00.000Z", ...over };
}
```

Replace the return with (adds the required `status`):

```ts
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over };
```

- [ ] **Step 5: Run the affected tests + typecheck**

Run: `pnpm exec vitest run tests/app/SaveRendering.test.ts tests/adapters/store/JsonFormattingStore.test.ts tests/app/FormatVariants.test.ts`
Expected: all pass (FormatVariants asserts channels/`refined`/counts, not full equality, so it stays green).

Run: `pnpm typecheck`
Expected: no errors (every `ChannelRendering` literal now sets `status`).

- [ ] **Step 6: Commit**

```bash
git add src/domain/formatting/models.ts src/app/FormatVariants.ts src/app/SaveRendering.ts tests/app/SaveRendering.test.ts tests/adapters/store/JsonFormattingStore.test.ts
git commit -m "feat: ChannelRendering gains a rendered/approved status (§7)"
```

---

## Task 2: `ApproveRendering` use-case

**Files:**
- Create: `src/app/ApproveRendering.ts`
- Test: `tests/app/ApproveRendering.test.ts`

**Interfaces:**
- Consumes: `FormattingStore`, `ChannelRendering`, `ConversionType`, `Channel`.
- Produces: `interface ApproveRenderingInput { itemId: string; type: ConversionType; channel: Channel }`; `class ApproveRendering` ctor `(formattingStore, now?)` with `run(input): Promise<ChannelRendering | undefined>` (undefined when no rendering matches).

- [ ] **Step 1: Write the failing test**

```ts
// tests/app/ApproveRendering.test.ts
import { describe, it, expect } from "vitest";
import { ApproveRendering } from "../../src/app/ApproveRendering";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function rnd(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "telegram", text: "t", refined: false,
    createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over };
}
function store(list: ChannelRendering[]) {
  const state = { list: list.map((r) => ({ ...r })) };
  const s: FormattingStore = {
    loadAll: async () => state.list,
    listRenderedKeys: async () => new Set(state.list.map((r) => `${r.itemId}:${r.type}:${r.channel}`)),
    upsert: async (r) => { state.list = [...state.list.filter((x) => !(x.itemId === r.itemId && x.type === r.type && x.channel === r.channel)), r]; },
  };
  return { s, state };
}

describe("ApproveRendering", () => {
  it("sets status approved + approvedAt on the matching rendering", async () => {
    const { s, state } = store([rnd()]);
    const uc = new ApproveRendering(s, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    expect(res?.status).toBe("approved");
    expect(res?.approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(res?.text).toBe("t"); // unchanged
    expect(state.list[0].status).toBe("approved");
  });

  it("returns undefined when no rendering matches", async () => {
    const { s } = store([rnd()]);
    const uc = new ApproveRendering(s);
    expect(await uc.run({ itemId: "x:9", type: "x", channel: "telegram" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/ApproveRendering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use-case**

```ts
// src/app/ApproveRendering.ts
import type { ConversionType } from "../domain/conversion/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";

export interface ApproveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class ApproveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: ApproveRenderingInput): Promise<ChannelRendering | undefined> {
    const all = await this.formattingStore.loadAll();
    const existing = all.find((r) => r.itemId === input.itemId && r.type === input.type && r.channel === input.channel);
    if (!existing) return undefined;
    const approved: ChannelRendering = { ...existing, status: "approved", approvedAt: this.now() };
    await this.formattingStore.upsert(approved);
    return approved;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/ApproveRendering.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/ApproveRendering.ts tests/app/ApproveRendering.test.ts
git commit -m "feat: ApproveRendering use-case (§7)"
```

---

## Task 3: API handlers — `/api/renderings` routes

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts`
- Modify: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `FormattingStore`, `ConversionStore`, `SaveRendering`, `ApproveRendering`, `ChannelRendering`, `ConversionType`, `Channel`.
- Produces: `ApiDeps` extended with `formattingStore`, `conversionStore`, `saveRendering`, `approveRendering`. Routes: `GET /api/renderings` (each rendering enriched with `convertedText`), `PUT /api/renderings/{itemId}/{type}/{channel}` (body `{ text }`), `POST /api/renderings/{itemId}/{type}/{channel}/approve`.

- [ ] **Step 1: Extend `ApiDeps` and add imports**

In `src/adapters/web/apiHandlers.ts`, add these imports at the top (below the existing imports):

```ts
import type { ChannelRendering, Channel } from "../../domain/formatting/models";
import type { ConversionType } from "../../domain/conversion/models";
import type { FormattingStore } from "../../ports/FormattingStore";
import type { ConversionStore } from "../../ports/ConversionStore";
import type { SaveRendering } from "../../app/SaveRendering";
import type { ApproveRendering } from "../../app/ApproveRendering";
```

Extend the `ApiDeps` interface with the four new deps:

```ts
export interface ApiDeps {
  translationStore: TranslationStore;
  saveTranslation: SaveTranslation;
  buildPublisher: (target: string) => Promise<PublishTranslations>;
  formattingStore: FormattingStore;
  conversionStore: ConversionStore;
  saveRendering: SaveRendering;
  approveRendering: ApproveRendering;
}
```

- [ ] **Step 2: Add the renderings routes**

In `handleApi`, insert this block **after** the `publish` block and **before** the final `return { status: 404, ... }`:

```ts
  if (segments[1] === "renderings") {
    if (method === "GET" && segments.length === 2) {
      const [renderings, variants] = await Promise.all([deps.formattingStore.loadAll(), deps.conversionStore.loadAll()]);
      const convertedByKey = new Map(variants.map((v) => [`${v.itemId}:${v.type}`, v.convertedText]));
      const enriched = renderings.map((r) => ({ ...r, convertedText: convertedByKey.get(`${r.itemId}:${r.type}`) ?? "" }));
      return { status: 200, json: enriched };
    }

    if (segments.length >= 5) {
      const itemId = decodeURIComponent(segments[2]);
      const type = segments[3] as ConversionType;
      const channel = segments[4] as Channel;
      const existing = (await deps.formattingStore.loadAll()).find(
        (r) => r.itemId === itemId && r.type === type && r.channel === channel,
      );

      if (method === "PUT" && segments.length === 5) {
        const text = (body as { text?: unknown })?.text;
        if (typeof text !== "string" || text.trim() === "") return { status: 400, json: { error: "text required" } };
        if (!existing) return { status: 404, json: { error: "not found" } };
        await deps.saveRendering.run({ itemId, type, channel, text });
        const updated = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        return { status: 200, json: updated };
      }

      if (method === "POST" && segments.length === 6 && segments[5] === "approve") {
        const updated = await deps.approveRendering.run({ itemId, type, channel });
        if (!updated) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: updated };
      }
    }
  }
```

- [ ] **Step 3: Update the test `makeDeps` to supply the new deps**

In `tests/adapters/web/apiHandlers.test.ts`, add imports:

```ts
import type { ChannelRendering } from "../../../src/domain/formatting/models";
import type { ContentVariant } from "../../../src/domain/conversion/models";
```

Add fixtures near `tr`:

```ts
function rnd(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "c", status: "rendered", ...over };
}
function cv(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "s", convertedText: "변환본", status: "approved", createdAt: "c", ...over };
}
```

Change `makeDeps` to accept renderings + variants and wire the four new deps. Its signature and the `return` become:

```ts
function makeDeps(list: Translation[], renderings: ChannelRendering[] = [], variants: ContentVariant[] = []): ApiDeps {
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

  const rstate = { list: renderings.map((r) => ({ ...r })) };
  const formattingStore = {
    loadAll: async () => rstate.list,
    listRenderedKeys: async () => new Set(rstate.list.map((r) => `${r.itemId}:${r.type}:${r.channel}`)),
    upsert: async (r: ChannelRendering) => {
      rstate.list = [...rstate.list.filter((x) => !(x.itemId === r.itemId && x.type === r.type && x.channel === r.channel)), r];
    },
  };
  const conversionStore = {
    loadAll: async () => variants,
    upsert: async () => {},
    listConvertedKeys: async () => new Set<string>(),
  };
  const saveRendering = {
    run: async (input: { itemId: string; type: ChannelRendering["type"]; channel: ChannelRendering["channel"]; text: string }) => {
      await formattingStore.upsert(rnd({ itemId: input.itemId, type: input.type, channel: input.channel, text: input.text, refined: true, status: "rendered" }));
      return { itemId: input.itemId, type: input.type, channel: input.channel };
    },
  } as unknown as ApiDeps["saveRendering"];
  const approveRendering = {
    run: async (input: { itemId: string; type: ChannelRendering["type"]; channel: ChannelRendering["channel"] }) => {
      const ex = rstate.list.find((r) => r.itemId === input.itemId && r.type === input.type && r.channel === input.channel);
      if (!ex) return undefined;
      const up: ChannelRendering = { ...ex, status: "approved", approvedAt: "a" };
      await formattingStore.upsert(up);
      return up;
    },
  } as unknown as ApiDeps["approveRendering"];

  return { translationStore, saveTranslation, buildPublisher, formattingStore, conversionStore, saveRendering, approveRendering };
}
```

- [ ] **Step 4: Add the rendering route tests**

Add these inside the existing `describe("handleApi", …)`:

```ts
  it("GET /api/renderings enriches each rendering with the variant convertedText", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })], [cv({ itemId: "x:1", type: "x", convertedText: "변환본" })]);
    const res = await handleApi(d, "GET", "/api/renderings", undefined);
    expect(res.status).toBe(200);
    const list = res.json as (ChannelRendering & { convertedText: string })[];
    expect(list[0].convertedText).toBe("변환본");
  });

  it("PUT edits a rendering's text and reverts it to rendered", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "telegram", status: "approved" })]);
    const res = await handleApi(d, "PUT", "/api/renderings/x%3A1/x/telegram", { text: "수정된 텍스트" });
    expect(res.status).toBe(200);
    expect((res.json as ChannelRendering).text).toBe("수정된 텍스트");
    expect((res.json as ChannelRendering).status).toBe("rendered");
  });

  it("PUT empty text is 400; unknown rendering is 404", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })]);
    expect((await handleApi(d, "PUT", "/api/renderings/x%3A1/x/x", { text: "" })).status).toBe(400);
    expect((await handleApi(d, "PUT", "/api/renderings/x%3A9/x/x", { text: "y" })).status).toBe(404);
  });

  it("POST approve sets status approved; unknown is 404", async () => {
    const d = makeDeps([], [rnd({ itemId: "x:1", type: "x", channel: "x" })]);
    const res = await handleApi(d, "POST", "/api/renderings/x%3A1/x/x/approve", undefined);
    expect(res.status).toBe(200);
    expect((res.json as ChannelRendering).status).toBe("approved");
    expect((await handleApi(d, "POST", "/api/renderings/x%3A9/x/x/approve", undefined)).status).toBe(404);
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm exec vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: PASS (existing translation tests + 4 new rendering tests).

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat: /api/renderings routes — list (with convertedText), edit, approve (§7)"
```

---

## Task 4: Composition root wiring (`serve.ts`)

**Files:**
- Modify: `src/cli/serve.ts`

**Interfaces:**
- Consumes: `JsonFormattingStore`, `JsonConversionStore`, `SaveRendering`, `ApproveRendering`, extended `ApiDeps`.

- [ ] **Step 1: Add imports**

In `src/cli/serve.ts`, add below the existing store/app imports:

```ts
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { SaveRendering } from "../app/SaveRendering";
import { ApproveRendering } from "../app/ApproveRendering";
```

- [ ] **Step 2: Construct the stores and extend `deps`**

After the existing `const saveTranslation = …` line, add:

```ts
const formattingStore = new JsonFormattingStore("output/formatted");
const conversionStore = new JsonConversionStore("output/variants");
```

Replace the `const deps: ApiDeps = { … };` block with:

```ts
const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  buildPublisher: async (target) => new PublishTranslations(translationStore, await uploadersFor(target), publishStore),
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore),
  approveRendering: new ApproveRendering(formattingStore),
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (composition root satisfies the extended `ApiDeps`).

- [ ] **Step 4: Commit**

```bash
git add src/cli/serve.ts
git commit -m "feat: serve wires formatting/conversion stores + rendering use-cases (§7)"
```

---

## Task 5: Frontend contract — `types.ts` + `api.ts`

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`

**Interfaces:**
- Produces: `Rendering` type; `api.listRenderings()`, `api.editRendering(itemId,type,channel,text)`, `api.approveRendering(itemId,type,channel)`.

- [ ] **Step 1: Add the `Rendering` type**

Append to `web/src/types.ts`:

```ts
export type ConversionType = "x" | "kol" | "pr";
export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export interface Rendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean;
  createdAt: string;
  status: "rendered" | "approved";
  approvedAt?: string;
  convertedText: string; // joined source context (variant convertedText)
}
```

- [ ] **Step 2: Add the rendering endpoints**

In `web/src/api.ts`, change the import to include the new types:

```ts
import type { Translation, PublishResult, Rendering, ConversionType, Channel } from "./types";
```

Add a path helper above `export const api` :

```ts
const rPath = (itemId: string, type: ConversionType, channel: Channel) =>
  `/api/renderings/${encodeURIComponent(itemId)}/${type}/${channel}`;
```

Add these three members inside the `api` object (after `publish`):

```ts
  listRenderings: () => fetch("/api/renderings").then((r) => json<Rendering[]>(r)),
  editRendering: (itemId: string, type: ConversionType, channel: Channel, text: string) =>
    fetch(rPath(itemId, type, channel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => json<Rendering>(r)),
  approveRendering: (itemId: string, type: ConversionType, channel: Channel) =>
    fetch(`${rPath(itemId, type, channel)}/approve`, { method: "POST" }).then((r) => json<Rendering>(r)),
```

- [ ] **Step 3: Type-check the frontend**

Run: `pnpm typecheck:web`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/types.ts web/src/api.ts
git commit -m "feat: frontend Rendering type + rendering API endpoints (§7)"
```

---

## Task 6: Frontend — mode toggle + rendering view

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/components/RenderingsView.tsx`
- Create: `web/src/components/RenderingList.tsx`
- Create: `web/src/components/RenderingDetail.tsx`

**Interfaces:**
- Consumes: `api.listRenderings/editRendering/approveRendering`, `Rendering`.
- The existing translation review body stays in `App.tsx`, rendered only in `mode === "translations"`; `RenderingsView` is rendered in `mode === "renderings"`. `App` keeps its shared `dirty` state; the header toggle confirms before switching modes while dirty.

- [ ] **Step 1: Create `RenderingList.tsx`**

```tsx
import { useState } from "react";
import type { Rendering } from "../types";

const badgeClass = (status: Rendering["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

const keyOf = (r: Rendering) => `${r.itemId}:${r.type}:${r.channel}`;

export function RenderingList(props: {
  items: Rendering[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [status, setStatus] = useState<"all" | Rendering["status"]>("all");
  const [channel, setChannel] = useState<"all" | Rendering["channel"]>("all");
  const [type, setType] = useState<"all" | Rendering["type"]>("all");
  const shown = props.items.filter(
    (r) =>
      (status === "all" || r.status === status) &&
      (channel === "all" || r.channel === channel) &&
      (type === "all" || r.type === type),
  );
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 px-2.5 py-2 border-b border-neutral-200">
        {(["all", "rendered", "approved"] as const).map((f) => (
          <button
            key={f}
            className={`text-xs px-2 py-1 rounded-full border ${status === f ? "bg-neutral-900 text-white border-neutral-900" : "bg-white border-neutral-300"}`}
            onClick={() => setStatus(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 px-2.5 py-2 border-b border-neutral-200">
        <select className="text-xs border border-neutral-300 rounded px-1 py-0.5" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
          <option value="all">all channels</option>
          <option value="x">x</option>
          <option value="telegram">telegram</option>
          <option value="kakao">kakao</option>
          <option value="pr_mail">pr_mail</option>
        </select>
        <select className="text-xs border border-neutral-300 rounded px-1 py-0.5" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="all">all types</option>
          <option value="x">x</option>
          <option value="kol">kol</option>
          <option value="pr">pr</option>
        </select>
      </div>
      <ul>
        {shown.map((r) => {
          const k = keyOf(r);
          return (
            <li
              key={k}
              className={`flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-neutral-100 cursor-pointer hover:bg-neutral-50 ${k === props.selectedKey ? "bg-indigo-50" : ""}`}
              onClick={() => props.onSelect(k)}
            >
              <span className="text-xs text-neutral-600 truncate">{r.itemId} · {r.type} · {r.channel}</span>
              <span className={`text-[11px] px-1.5 py-0.5 rounded ${badgeClass(r.status)}`}>{r.status}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Create `RenderingDetail.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { Rendering } from "../types";

const badgeClass = (status: Rendering["status"]) =>
  status === "approved" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800";

export function RenderingDetail(props: {
  item: Rendering;
  onSave: (item: Rendering, text: string) => Promise<void>;
  onApprove: (item: Rendering) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { onDirtyChange } = props;
  const [text, setText] = useState(props.item.text);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setText(props.item.text), [props.item.itemId, props.item.type, props.item.channel, props.item.text]);

  const dirty = text !== props.item.text;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    await navigator.clipboard.writeText(props.item.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3">
        <code className="text-sm">{props.item.itemId} · {props.item.type} · {props.item.channel}</code>
        <span className={`text-[11px] px-1.5 py-0.5 rounded ${badgeClass(props.item.status)}`}>{props.item.status}</span>
        {props.item.refined && <span className="text-[11px] text-neutral-400">refined</span>}
      </div>
      <h3 className="font-semibold text-neutral-700 mb-1">변환 원문 (converted)</h3>
      <div className="whitespace-pre-wrap text-sm mb-4 text-neutral-600">{props.item.convertedText}</div>
      <h3 className="font-semibold text-neutral-700 mb-1">채널 텍스트 ({props.item.channel}){dirty ? " • 편집중" : ""}</h3>
      <textarea
        className="w-full min-h-56 text-sm p-2 border border-neutral-300 rounded"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex gap-2.5 mt-3">
        <button
          className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white disabled:opacity-50"
          disabled={busy || !dirty}
          onClick={() => run(() => props.onSave(props.item, text))}
        >
          저장
        </button>
        <button
          className="px-3.5 py-1.5 rounded-md bg-indigo-600 text-white disabled:opacity-50"
          disabled={busy || dirty}
          onClick={() => run(() => props.onApprove(props.item))}
        >
          승인 ✓
        </button>
        <button className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white" onClick={copy}>
          {copied ? "복사됨 ✓" : "승인본 복사"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create `RenderingsView.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Rendering } from "../types";
import { RenderingList } from "./RenderingList";
import { RenderingDetail } from "./RenderingDetail";

const keyOf = (r: Rendering) => `${r.itemId}:${r.type}:${r.channel}`;

export function RenderingsView(props: { onDirtyChange: (dirty: boolean) => void }) {
  const { onDirtyChange } = props;
  const [items, setItems] = useState<Rendering[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = () => api.listRenderings().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const selected = items.find((r) => keyOf(r) === selectedKey) ?? null;

  const handleSelect = (k: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedKey(k);
  };
  const onSave = async (item: Rendering, text: string) => {
    setError(null);
    try {
      await api.editRendering(item.itemId, item.type, item.channel, text);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  const onApprove = async (item: Rendering) => {
    setError(null);
    try {
      await api.approveRendering(item.itemId, item.type, item.channel);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <>
      {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
      <div className="flex flex-1 min-h-0">
        <aside className="w-72 border-r border-neutral-200 overflow-y-auto">
          <RenderingList items={items} selectedKey={selectedKey} onSelect={handleSelect} />
        </aside>
        <section className="flex-1 p-6 overflow-y-auto">
          {selected ? (
            <RenderingDetail item={selected} onSave={onSave} onApprove={onApprove} onDirtyChange={setDirty} />
          ) : (
            <p className="text-neutral-400">
              항목을 선택하세요. (렌더링이 없으면 먼저 <code>pnpm format</code> 실행)
            </p>
          )}
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Wire the mode toggle into `App.tsx`**

Replace the entire contents of `web/src/App.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { api } from "./api";
import type { Translation } from "./types";
import { TranslationList } from "./components/TranslationList";
import { TranslationDetail } from "./components/TranslationDetail";
import { PublishBar } from "./components/PublishBar";
import { RenderingsView } from "./components/RenderingsView";

type Mode = "translations" | "renderings";

export function App() {
  const [mode, setMode] = useState<Mode>("translations");
  const [items, setItems] = useState<Translation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = () => api.list().then(setItems).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => {
    refresh();
  }, []);

  const selected = items.find((t) => t.itemId === selectedId) ?? null;

  const switchMode = (m: Mode) => {
    if (m !== mode && dirty && !window.confirm("저장하지 않은 편집이 있습니다. 모드를 바꿀까요?")) return;
    setDirty(false);
    setMode(m);
  };

  const handleSelect = (id: string) => {
    if (dirty && !window.confirm("저장하지 않은 편집이 있습니다. 그래도 이동할까요?")) return;
    setSelectedId(id);
  };
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

  const tab = (active: boolean) =>
    `text-sm px-2.5 py-1 rounded-md ${active ? "bg-white text-neutral-900" : "bg-white/10 text-white"}`;

  return (
    <div className="flex flex-col h-screen text-neutral-900">
      <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-neutral-950 text-white font-semibold">
        <div className="flex items-center gap-3">
          <span>Mantle KR — Review</span>
          <nav className="flex gap-1">
            <button className={tab(mode === "translations")} onClick={() => switchMode("translations")}>1차 검수 (번역)</button>
            <button className={tab(mode === "renderings")} onClick={() => switchMode("renderings")}>2차 검수 (채널)</button>
          </nav>
        </div>
        {mode === "translations" && <PublishBar />}
      </header>

      {mode === "translations" ? (
        <>
          {error && <div className="bg-red-100 text-red-800 px-4 py-2 text-sm">{error}</div>}
          <div className="flex flex-1 min-h-0">
            <aside className="w-72 border-r border-neutral-200 overflow-y-auto">
              <TranslationList items={items} selectedId={selectedId} onSelect={handleSelect} />
            </aside>
            <section className="flex-1 p-6 overflow-y-auto">
              {selected ? (
                <TranslationDetail item={selected} onSave={onSave} onApprove={onApprove} onDirtyChange={setDirty} />
              ) : (
                <p className="text-neutral-400">항목을 선택하세요.</p>
              )}
            </section>
          </div>
        </>
      ) : (
        <RenderingsView onDirtyChange={setDirty} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Type-check and build the frontend**

Run: `pnpm typecheck:web`
Expected: no errors.

Run: `pnpm build:web`
Expected: Vite build succeeds, writes `web/dist`.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/components/RenderingsView.tsx web/src/components/RenderingList.tsx web/src/components/RenderingDetail.tsx
git commit -m "feat: dashboard 2차 검수 mode — rendering list/detail + mode toggle (§7)"
```

---

## Task 7: Full-suite verification + docs

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full suite + both type-checks**

Run: `pnpm test`
Expected: all pass (existing + `ApproveRendering` + new apiHandlers rendering tests). If anything fails, STOP and report — do not edit docs over a red suite.

Run: `pnpm typecheck && pnpm typecheck:web`
Expected: both clean.

- [ ] **Step 2: Document the 2차 검수 mode in the README**

In `README.md`, inside the **Module E** section, append this paragraph after the existing `Open http://localhost:5757:` line:

```markdown

The dashboard has two review modes (header toggle): **1차 검수 (번역)** reviews Module C
translations, and **2차 검수 (채널)** reviews Module F channel renderings (§7) — list/filter by
status·channel·type, view the converted source, edit the channel text, approve, and copy the
approved text for manual posting. Renderings come from `pnpm format`; run it first if the list is empty.
```

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, under the existing `## [Unreleased]` → `### Added` list, add one bullet:

```markdown
- **Second review (§7)** — the local dashboard gains a **2차 검수** mode to list/filter, edit, and
  approve Module F channel renderings before posting. `ChannelRendering` gains a `rendered`/`approved`
  status; new `ApproveRendering` use-case and `/api/renderings` routes; approved text is copy-ready.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: second review (§7) — README + CHANGELOG"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** model+state (Task 1), `ApproveRendering` (Task 2), API list/edit/approve with `convertedText` join (Task 3), composition wiring (Task 4), frontend contract (Task 5), mode toggle + rendering list/detail + copy button (Task 6), tests throughout, docs (Task 7). §8 upload explicitly out of scope — no tasks.
- **Edit reverts to `rendered`:** enforced because the edit route reuses `SaveRendering`, which sets `status: "rendered"` (Task 1). Verified by the apiHandlers PUT test asserting `status === "rendered"` after editing an `approved` rendering.
- **Frontend has no unit-test harness** (matches E): verified by `pnpm typecheck:web` + `pnpm build:web` + the existing manual `pnpm serve` e2e approach.
- **No new runtime deps:** backend uses existing ports/use-cases; frontend deps unchanged.
