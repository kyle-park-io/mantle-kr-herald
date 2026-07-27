# Translation Memory — reference-account backfill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect @0xMantleKR's published Korean posts, pair them with Mantle_Official's English posts into a human-confirmed translation memory (TM), and inline the most relevant TM pairs into every translation worksheet.

**Architecture:** Reuse the existing X collection engine wired to an isolated reference store; three pure domain functions (anchor extraction, EN↔KO pairing, relevance selection); four thin CLIs (`collect:reference`, `tm:measure`, `tm:pair`, `tm:promote`); one change to `PrepareTranslations` that replaces "last-8 few-shots" with "curated few-shots + top-K relevant TM pairs". The per-item align pass is a separate future slice that reuses the pairing + selection functions built here.

**Tech Stack:** TypeScript (ESM, `tsx`), Node built-ins, `zod` (schema parsing), `vitest`. No new runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-27-translation-memory-backfill-design.md`

## Global Constraints

- **Runtime dependencies stay zod-only.** No new npm runtime deps; use Node built-ins.
- **Public repo — never commit real KR/English post text.** `translation/tm.json` is already git-ignored by `.gitignore`'s `translation/*` rule; only `translation/tm.example.json` (empty `[]`) is tracked (`!translation/*.example.json`). All `output/x/reference/*` artifacts are under the already-ignored `output/`. Do **not** add real pairs to any tracked file.
- **Reference store is isolated from the source store.** @0xMantleKR is collected into `output/x/reference/`; `XContentSource` used for the *translation queue* is only ever pointed at `paths.xItems`. A Korean post must never enter the translation queue.
- **Precision over recall in pairing.** No pair enters the TM without human confirmation. `tm:pair` proposes; a human edits `accept` flags; `tm:promote` writes only accepted pairs.
- **Curated few-shot is untouched.** `translation/few-shot.json` selection keeps its current rule (`fewShots.slice(-MAX_FEW_SHOTS)`). TM is an additive, disjoint budget (`MAX_TM_FEW_SHOTS`), never displacing a curated example.
- **Follow existing patterns.** Pure logic in `src/domain/`, tested in isolation; CLIs are thin composition wiring existing tested pieces; stores are JSON via `readJsonFile`/`writeJsonFileAtomic`; API CLIs run with `tsx --env-file-if-exists=.env`, offline CLIs with plain `tsx`.
- **Every test must be able to fail.** Pin each threshold/branch; mutation-check assertions (the recurring "test that cannot fail" defect from prior slices).

---

### Task 1: Anchor extraction

**Files:**
- Create: `src/domain/tm/anchors.ts`
- Test: `tests/domain/tm/anchors.test.ts`

**Interfaces:**
- Produces:
  - `extractAnchors(text: string): string[]` — deduped, lowercased anchor tokens (cashtags, hashtags, mentions).
  - `sharedAnchors(a: string[], b: string[]): string[]` — intersection of two anchor lists (order follows `a`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractAnchors, sharedAnchors } from "../../../src/domain/tm/anchors";

describe("extractAnchors", () => {
  it("pulls cashtags, hashtags and mentions, lowercased", () => {
    const got = extractAnchors("Big for $MNT with @Bybit_Official #Mantle");
    expect(got.sort()).toEqual(["#mantle", "$mnt", "@bybit_official"]);
  });

  it("dedupes case-insensitively", () => {
    expect(extractAnchors("$MNT $mnt $Mnt")).toEqual(["$mnt"]);
  });

  it("returns [] when there are no anchors", () => {
    expect(extractAnchors("plain text, no tags here")).toEqual([]);
  });
});

describe("sharedAnchors", () => {
  it("returns the intersection", () => {
    expect(sharedAnchors(["$mnt", "#mantle", "@a"], ["#mantle", "@a", "@b"])).toEqual(["#mantle", "@a"]);
  });

  it("is empty when nothing overlaps", () => {
    expect(sharedAnchors(["$mnt"], ["#mantle"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/tm/anchors.test.ts`
Expected: FAIL — cannot resolve `../../../src/domain/tm/anchors`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/tm/anchors.ts

/** Tokens that survive translation intact, so they anchor an EN post to its KO translation.
 *  URLs are deliberately excluded: tweet text carries per-share t.co links that differ between
 *  the two posts, so they never match. Cashtags/hashtags/mentions are copied verbatim. */
const CASHTAG = /\$[A-Za-z][A-Za-z0-9_]*/g;
const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const MENTION = /@[A-Za-z0-9_]{1,15}/g;

export function extractAnchors(text: string): string[] {
  const found = new Set<string>();
  for (const re of [CASHTAG, HASHTAG, MENTION]) {
    for (const m of text.matchAll(re)) found.add(m[0].toLowerCase());
  }
  return [...found];
}

export function sharedAnchors(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/tm/anchors.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/anchors.ts tests/domain/tm/anchors.test.ts
git commit -m "feat(tm): anchor extraction for EN↔KO pairing"
```

---

### Task 2: EN↔KO pairing

**Files:**
- Create: `src/domain/tm/pairing.ts`
- Test: `tests/domain/tm/pairing.test.ts`

**Interfaces:**
- Consumes: `extractAnchors`, `sharedAnchors` (Task 1); `ContentItem` from `src/domain/translation/contentItem.ts` (`{ id, source, text, createdAt, refUrl?, kind? }`).
- Produces:
  - `interface PairOptions { windowDays: number; minAnchors: number }`
  - `interface ProposedPair { enId: string; koId: string; score: number; shared: string[]; source: string; target: string }`
  - `proposePairs(enItems: ContentItem[], koItems: ContentItem[], opts: PairOptions): ProposedPair[]` — for each KO item, the single best EN item published within `windowDays` **before** it and sharing at least `minAnchors` anchors. `source` is the EN text, `target` the KO text.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { proposePairs, type PairOptions } from "../../../src/domain/tm/pairing";
import type { ContentItem } from "../../../src/domain/translation/contentItem";

const opts: PairOptions = { windowDays: 14, minAnchors: 2 };

function en(id: string, createdAt: string, text: string): ContentItem {
  return { id, source: "x", text, createdAt };
}
function ko(id: string, createdAt: string, text: string): ContentItem {
  return { id, source: "x", text, createdAt };
}

describe("proposePairs", () => {
  it("pairs a KO post to the EN post it translates (≥minAnchors, within window, KO after EN)", () => {
    const enItems = [en("x:1", "2026-07-10T00:00:00Z", "$MNT rewards live #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT 리워드 시작 #Mantle")];
    const pairs = proposePairs(enItems, koItems, opts);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ enId: "x:1", koId: "x:100", score: 2 });
    expect(pairs[0].shared.sort()).toEqual(["#mantle", "$mnt"]);
    expect(pairs[0].source).toContain("rewards");
    expect(pairs[0].target).toContain("리워드");
  });

  it("rejects a candidate sharing fewer than minAnchors", () => {
    const enItems = [en("x:1", "2026-07-10T00:00:00Z", "$MNT only")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT 만")]; // shares $mnt only → 1 < 2
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("rejects a KO post published BEFORE the EN post", () => {
    const enItems = [en("x:1", "2026-07-12T00:00:00Z", "$MNT #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle")]; // gap negative
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("rejects a candidate outside the window", () => {
    const enItems = [en("x:1", "2026-06-01T00:00:00Z", "$MNT #Mantle")];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle")]; // >14 days
    expect(proposePairs(enItems, koItems, opts)).toEqual([]);
  });

  it("chooses the highest-anchor EN candidate", () => {
    const enItems = [
      en("x:1", "2026-07-10T00:00:00Z", "$MNT #Mantle"),
      en("x:2", "2026-07-10T06:00:00Z", "$MNT #Mantle @Bybit_Official"),
    ];
    const koItems = [ko("x:100", "2026-07-11T00:00:00Z", "$MNT #Mantle @Bybit_Official 소식")];
    const pairs = proposePairs(enItems, koItems, opts);
    expect(pairs[0].enId).toBe("x:2");
    expect(pairs[0].score).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/tm/pairing.test.ts`
Expected: FAIL — cannot resolve `../../../src/domain/tm/pairing`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/tm/pairing.ts
import type { ContentItem } from "../translation/contentItem";
import { extractAnchors, sharedAnchors } from "./anchors";

export interface PairOptions {
  /** KO must be published no more than this many days AFTER the EN post. */
  windowDays: number;
  /** Reject candidates sharing fewer than this many anchors. */
  minAnchors: number;
}

export interface ProposedPair {
  enId: string;
  koId: string;
  score: number;
  shared: string[];
  source: string; // EN text
  target: string; // KO text
}

const DAY_MS = 86_400_000;

export function proposePairs(
  enItems: ContentItem[],
  koItems: ContentItem[],
  opts: PairOptions,
): ProposedPair[] {
  const en = enItems.map((item) => ({ item, anchors: extractAnchors(item.text), t: Date.parse(item.createdAt) }));
  const pairs: ProposedPair[] = [];

  for (const ko of koItems) {
    const koT = Date.parse(ko.createdAt);
    if (Number.isNaN(koT)) continue;
    const koAnchors = extractAnchors(ko.text);

    let best: { item: ContentItem; shared: string[]; gap: number } | undefined;
    for (const cand of en) {
      if (Number.isNaN(cand.t)) continue;
      const gap = koT - cand.t;
      if (gap < 0 || gap > opts.windowDays * DAY_MS) continue;
      const shared = sharedAnchors(cand.anchors, koAnchors);
      if (shared.length < opts.minAnchors) continue;
      if (
        best === undefined ||
        shared.length > best.shared.length ||
        (shared.length === best.shared.length && gap < best.gap)
      ) {
        best = { item: cand.item, shared, gap };
      }
    }

    if (best) {
      pairs.push({
        enId: best.item.id,
        koId: ko.id,
        score: best.shared.length,
        shared: best.shared,
        source: best.item.text,
        target: ko.text,
      });
    }
  }
  return pairs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/tm/pairing.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/pairing.ts tests/domain/tm/pairing.test.ts
git commit -m "feat(tm): propose EN↔KO pairs by anchor overlap within a temporal window"
```

---

### Task 3: TM relevance selection

**Files:**
- Create: `src/domain/tm/selection.ts`
- Test: `tests/domain/tm/selection.test.ts`

**Interfaces:**
- Consumes: `extractAnchors`, `sharedAnchors` (Task 1); `ContentItem`; `FewShotExample` from `src/domain/translation/models.ts` (`{ source, target, itemId? }`).
- Produces: `selectRelevantTm(batch: ContentItem[], tm: FewShotExample[], k: number): FewShotExample[]` — the up-to-`k` TM pairs whose English `source` shares the most anchors with the batch. Pairs sharing nothing are excluded; ties keep input order (stable).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { selectRelevantTm } from "../../../src/domain/tm/selection";
import type { ContentItem } from "../../../src/domain/translation/contentItem";
import type { FewShotExample } from "../../../src/domain/translation/models";

const batch: ContentItem[] = [
  { id: "x:1", source: "x", text: "$MNT staking goes live #Mantle", createdAt: "2026-07-20T00:00:00Z" },
];

const tm: FewShotExample[] = [
  { source: "$MNT rewards #Mantle @Bybit_Official", target: "리워드", itemId: "x:a" }, // shares $mnt,#mantle = 2
  { source: "$MNT news", target: "소식", itemId: "x:b" },                              // shares $mnt = 1
  { source: "unrelated $OTHER #Foo", target: "무관", itemId: "x:c" },                   // shares nothing = 0
];

describe("selectRelevantTm", () => {
  it("ranks by anchor overlap and drops zero-overlap pairs", () => {
    const got = selectRelevantTm(batch, tm, 5);
    expect(got.map((e) => e.itemId)).toEqual(["x:a", "x:b"]);
  });

  it("caps at k", () => {
    expect(selectRelevantTm(batch, tm, 1).map((e) => e.itemId)).toEqual(["x:a"]);
  });

  it("returns [] for an empty TM", () => {
    expect(selectRelevantTm(batch, [], 5)).toEqual([]);
  });

  it("returns [] when nothing in the batch shares an anchor", () => {
    const other: ContentItem[] = [{ id: "x:9", source: "x", text: "plain text", createdAt: "2026-07-20T00:00:00Z" }];
    expect(selectRelevantTm(other, tm, 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/tm/selection.test.ts`
Expected: FAIL — cannot resolve `../../../src/domain/tm/selection`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/tm/selection.ts
import type { ContentItem } from "../translation/contentItem";
import type { FewShotExample } from "../translation/models";
import { extractAnchors, sharedAnchors } from "./anchors";

export function selectRelevantTm(batch: ContentItem[], tm: FewShotExample[], k: number): FewShotExample[] {
  const batchAnchors = [...new Set(batch.flatMap((i) => extractAnchors(i.text)))];
  return tm
    .map((ex) => ({ ex, score: sharedAnchors(extractAnchors(ex.source), batchAnchors).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k)
    .map((s) => s.ex);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/tm/selection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/selection.ts tests/domain/tm/selection.test.ts
git commit -m "feat(tm): select the TM pairs most relevant to a translation batch"
```

---

### Task 4: TM store (parameterized filename) + tracked example

**Files:**
- Modify: `src/adapters/store/JsonFewShotStore.ts`
- Create: `translation/tm.example.json`
- Test: `tests/adapters/jsonFewShotStore.tm.test.ts`

**Interfaces:**
- Consumes: existing `FewShotStore` port (`load()`, `add(ex)`), `FewShotExample`.
- Produces: `new JsonFewShotStore(dir, fileName?)` — `fileName` defaults to `"few-shot.json"`, so all existing call sites are unchanged; `new JsonFewShotStore(dir, "tm.json")` gives a second corpus at `dir/tm.json`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFewShotStore } from "../../src/adapters/store/JsonFewShotStore";

describe("JsonFewShotStore with a custom filename", () => {
  it("reads and writes the named file, not few-shot.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tm-store-"));
    const store = new JsonFewShotStore(dir, "tm.json");
    expect(await store.load()).toEqual([]);
    await store.add({ source: "$MNT news", target: "소식", itemId: "x:1" });
    const onDisk = JSON.parse(await readFile(join(dir, "tm.json"), "utf8"));
    expect(onDisk).toEqual([{ source: "$MNT news", target: "소식", itemId: "x:1" }]);
  });

  it("still defaults to few-shot.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-store-"));
    const store = new JsonFewShotStore(dir);
    await store.add({ source: "a", target: "b" });
    const onDisk = JSON.parse(await readFile(join(dir, "few-shot.json"), "utf8"));
    expect(onDisk).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/jsonFewShotStore.tm.test.ts`
Expected: FAIL — the second constructor argument is not accepted / `tm.json` is not written.

- [ ] **Step 3: Implement — parameterize the filename**

In `src/adapters/store/JsonFewShotStore.ts`, change the constructor:

```ts
export class JsonFewShotStore implements FewShotStore {
  private readonly path: string;
  constructor(private readonly dir: string, fileName = "few-shot.json") {
    this.path = join(dir, fileName);
  }
  // load() and add() unchanged
```

Create `translation/tm.example.json`:

```json
[]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/adapters/jsonFewShotStore.tm.test.ts`
Expected: PASS (2 tests).
Run: `git check-ignore translation/tm.json && echo IGNORED; git check-ignore translation/tm.example.json || echo TRACKED`
Expected: prints `IGNORED` then `TRACKED` (real TM stays local; the example is committable).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/store/JsonFewShotStore.ts translation/tm.example.json tests/adapters/jsonFewShotStore.tm.test.ts
git commit -m "feat(tm): JsonFewShotStore filename param + tracked tm.example.json"
```

---

### Task 5: User-profile read + `tm:measure`

**Files:**
- Modify: `src/domain/models.ts` (add `UserProfile`)
- Modify: `src/adapters/twitterapi/schemas.ts` (add `parseUserProfile`)
- Modify: `src/adapters/twitterapi/TwitterApiSourceGateway.ts` (add `fetchUserProfile`)
- Create: `src/domain/tm/measureReport.ts`
- Create: `src/cli/tm-measure.ts`
- Modify: `package.json` (add `tm:measure` script)
- Test: `tests/adapters/parseUserProfile.test.ts`, `tests/domain/tm/measureReport.test.ts`

**Interfaces:**
- Produces:
  - `interface UserProfile { userName: string; statusesCount?: number }` (in `src/domain/models.ts`)
  - `parseUserProfile(data: unknown, fallbackUserName: string): UserProfile`
  - `TwitterApiSourceGateway.fetchUserProfile(userName: string): Promise<UserProfile>` (concrete class only — **not** added to the `SourceGateway` port, so existing stubs are untouched)
  - `formatMeasureReport(p: UserProfile, pageSize: number, maxPages: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/adapters/parseUserProfile.test.ts
import { describe, it, expect } from "vitest";
import { parseUserProfile } from "../../src/adapters/twitterapi/schemas";

describe("parseUserProfile", () => {
  it("reads statusesCount from data", () => {
    const got = parseUserProfile({ data: { userName: "0xMantleKR", statusesCount: 4316 } }, "fallback");
    expect(got).toEqual({ userName: "0xMantleKR", statusesCount: 4316 });
  });

  it("falls back to the requested handle and leaves count undefined when absent", () => {
    expect(parseUserProfile({ data: {} }, "0xMantleKR")).toEqual({ userName: "0xMantleKR", statusesCount: undefined });
  });

  it("tolerates a malformed response", () => {
    expect(parseUserProfile({ nope: true }, "0xMantleKR")).toEqual({ userName: "0xMantleKR", statusesCount: undefined });
  });
});
```

```ts
// tests/domain/tm/measureReport.test.ts
import { describe, it, expect } from "vitest";
import { formatMeasureReport } from "../../../src/domain/tm/measureReport";

describe("formatMeasureReport", () => {
  it("estimates pages and incremental runs from the post count", () => {
    const msg = formatMeasureReport({ userName: "0xMantleKR", statusesCount: 4316 }, 20, 50);
    expect(msg).toContain("4316");
    expect(msg).toContain("216"); // ceil(4316/20)
    expect(msg).toContain("5");   // ceil(216/50)
  });

  it("degrades gracefully when the count is unknown", () => {
    const msg = formatMeasureReport({ userName: "0xMantleKR" }, 20, 50);
    expect(msg).toContain("unavailable");
    expect(msg).toContain("collect:reference");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/adapters/parseUserProfile.test.ts tests/domain/tm/measureReport.test.ts`
Expected: FAIL — `parseUserProfile` / `formatMeasureReport` do not exist.

- [ ] **Step 3: Implement**

Add to `src/domain/models.ts`:

```ts
export interface UserProfile {
  userName: string;
  statusesCount?: number;
}
```

Add to `src/adapters/twitterapi/schemas.ts` (reuse the file's existing `import { z }`; add `UserProfile` to the existing `../../domain/models` import):

```ts
const UserProfileData = z
  .object({ userName: z.string().optional(), statusesCount: z.number().optional() })
  .passthrough();
const UserInfoResponse = z.object({ data: UserProfileData });

export function parseUserProfile(data: unknown, fallbackUserName: string): UserProfile {
  const r = UserInfoResponse.safeParse(data);
  const d = r.success ? r.data.data : {};
  return {
    userName: d.userName ?? fallbackUserName,
    statusesCount: typeof d.statusesCount === "number" ? d.statusesCount : undefined,
  };
}
```

Add to `src/adapters/twitterapi/TwitterApiSourceGateway.ts` (import `parseUserProfile` and `UserProfile`):

```ts
/** Account profile (for volume/cost estimation). Not on the SourceGateway port — only the
 *  measure CLI needs it, and adding it to the port would force every stub to implement it. */
async fetchUserProfile(userName: string): Promise<UserProfile> {
  const data = await this.client.get<unknown>("/twitter/user/info", { userName });
  return parseUserProfile(data, userName);
}
```

Create `src/domain/tm/measureReport.ts`:

```ts
import type { UserProfile } from "../models";

export function formatMeasureReport(p: UserProfile, pageSize: number, maxPages: number): string {
  if (p.statusesCount === undefined) {
    return `@${p.userName} — post count unavailable from the API. Run \`pnpm collect:reference\` incrementally; output/x/reference/runs.json reports coverage.`;
  }
  const pages = Math.ceil(p.statusesCount / pageSize);
  const runs = Math.ceil(pages / maxPages);
  return `@${p.userName} — ~${p.statusesCount} posts. ~${pages} advanced_search pages (~${pageSize}/page); with the ${maxPages}-page cap, ~${runs} incremental \`pnpm collect:reference\` run(s) cover full history.`;
}
```

Create `src/cli/tm-measure.ts`:

```ts
import "./registerErrorHandler";
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { formatMeasureReport } from "../domain/tm/measureReport";

// advanced_search yields ~20 tweets/page; the gateway caps a single run at MAX_PAGES=50.
const PAGE_SIZE = 20;
const MAX_PAGES = 50;

const handle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";
const target = process.argv[2]?.startsWith("--") ? handle : process.argv[2] ?? handle;

const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));
const profile = await gateway.fetchUserProfile(target);
console.log(formatMeasureReport(profile, PAGE_SIZE, MAX_PAGES));
```

Add to `package.json` scripts (after the `collect` lines):

```json
    "tm:measure": "tsx --env-file-if-exists=.env src/cli/tm-measure.ts",
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test -- tests/adapters/parseUserProfile.test.ts tests/domain/tm/measureReport.test.ts`
Expected: PASS (5 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/models.ts src/adapters/twitterapi/schemas.ts src/adapters/twitterapi/TwitterApiSourceGateway.ts src/domain/tm/measureReport.ts src/cli/tm-measure.ts package.json tests/adapters/parseUserProfile.test.ts tests/domain/tm/measureReport.test.ts
git commit -m "feat(tm): tm:measure reports reference-account volume and backfill cost"
```

---

### Task 6: Reference collection (`collect:reference`) + isolated store paths

**Files:**
- Modify: `src/paths.ts` (add reference + pairs paths)
- Create: `src/cli/collect-reference.ts`
- Modify: `package.json` (add `collect:reference` script)
- Test: `tests/paths.reference.test.ts`

**Interfaces:**
- Consumes: `CollectAuthoredContent(source, repo, watermark, ledger)`, `LocalJsonStore(dir)` (implements repo + watermark), `JsonCollectionRunLedger(runsPath)`, `TwitterApiSourceGateway`, `parseSince`.
- Produces (in `paths`): `referenceDir`, `referenceItems`, `referenceRuns`, `referencePairsProposed`, `referencePairsReview`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { paths } from "../src/paths";

describe("reference store isolation", () => {
  it("keeps the reference store under output/x/reference, distinct from the source store", () => {
    expect(paths.referenceItems).toContain("/output/x/reference/");
    expect(paths.referenceItems).not.toBe(paths.xItems);
    expect(paths.referenceRuns).not.toBe(paths.xRuns);
  });

  it("places the pairing artifacts in the reference dir", () => {
    expect(paths.referencePairsProposed).toContain("/output/x/reference/");
    expect(paths.referencePairsReview).toContain("/output/x/reference/");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/paths.reference.test.ts`
Expected: FAIL — `paths.referenceItems` is undefined.

- [ ] **Step 3: Implement**

Add to the `paths` object in `src/paths.ts` (after the `xRuns` line):

```ts
  referenceDir: join(OUTPUT_DIR, "x", "reference"),
  referenceItems: join(OUTPUT_DIR, "x", "reference", "items.json"),
  referenceRuns: join(OUTPUT_DIR, "x", "reference", "runs.json"),
  referencePairsProposed: join(OUTPUT_DIR, "x", "reference", "pairs-proposed.json"),
  referencePairsReview: join(OUTPUT_DIR, "x", "reference", "pairs-review.md"),
```

Create `src/cli/collect-reference.ts` (mirror of `collect.ts`, wired to the reference store + `REFERENCE_X_HANDLE`):

```ts
import "./registerErrorHandler";
import { loadConfig } from "../config";
import { argValue } from "./args";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { JsonCollectionRunLedger } from "../adapters/store/JsonCollectionRunLedger";
import { CollectAuthoredContent, type CollectOptions } from "../app/CollectAuthoredContent";
import { parseSince } from "../shared/time/parseSince";
import { paths } from "../paths";

const handle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";
const target = process.argv[2]?.startsWith("--") ? handle : process.argv[2] ?? handle;

const opts: CollectOptions = {};
const since = argValue("--since");
if (since) opts.since = parseSince(since, new Date());
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --limit "${limit}" (use a positive integer)`);
  opts.limit = Math.floor(n);
}

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore(paths.referenceDir);
const ledger = new JsonCollectionRunLedger(paths.referenceRuns);
const usecase = new CollectAuthoredContent(source, store, store, ledger);

const { run } = await usecase.run(target, opts);

const cov = run.covered ? `covered ${run.covered.from} ~ ${run.covered.to}` : "nothing new in window";
const gap = run.gap ? `, GAP ${run.gap.from ?? "(open)"} ~ ${run.gap.to} (limit reached)` : "";
console.log(
  `collected ${run.threadCount} reference threads (${run.tweetCount} tweets) for @${target} — ${cov}${gap}`,
);
```

Add to `package.json` scripts (right after the `collect` line):

```json
    "collect:reference": "tsx --env-file-if-exists=.env src/cli/collect-reference.ts",
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/paths.reference.test.ts`
Expected: PASS (2 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/cli/collect-reference.ts package.json tests/paths.reference.test.ts
git commit -m "feat(tm): collect:reference into an isolated output/x/reference store"
```

---

### Task 7: `tm:pair` — propose pairs + review artifacts

**Files:**
- Create: `src/domain/tm/pairsReview.ts`
- Create: `src/cli/tm-pair.ts`
- Modify: `package.json` (add `tm:pair` script)
- Test: `tests/domain/tm/pairsReview.test.ts`

**Interfaces:**
- Consumes: `ProposedPair` (Task 2), `proposePairs` (Task 2), `XContentSource(itemsPath).loadPending(Set)`, `paths.*` (Task 6), `writeJsonFileAtomic`.
- Produces:
  - `interface ProposedRecord extends ProposedPair { accept: boolean }`
  - `toProposedRecords(pairs: ProposedPair[]): ProposedRecord[]` — every record starts `accept: true`.
  - `renderPairsReview(pairs: ProposedPair[]): string` — human-readable markdown.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { toProposedRecords, renderPairsReview } from "../../../src/domain/tm/pairsReview";
import type { ProposedPair } from "../../../src/domain/tm/pairing";

const pair: ProposedPair = {
  enId: "x:1", koId: "x:100", score: 2, shared: ["$mnt", "#mantle"],
  source: "$MNT rewards #Mantle", target: "$MNT 리워드 #Mantle",
};

describe("toProposedRecords", () => {
  it("defaults every record to accept:true", () => {
    expect(toProposedRecords([pair])).toEqual([{ ...pair, accept: true }]);
  });
});

describe("renderPairsReview", () => {
  it("shows the ids, score, and both texts", () => {
    const md = renderPairsReview([pair]);
    expect(md).toContain("x:1");
    expect(md).toContain("x:100");
    expect(md).toContain("score 2");
    expect(md).toContain("$MNT rewards #Mantle");
    expect(md).toContain("$MNT 리워드 #Mantle");
  });

  it("handles the empty case", () => {
    expect(renderPairsReview([])).toContain("제안된 쌍 없음");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/tm/pairsReview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/domain/tm/pairsReview.ts`:

```ts
import type { ProposedPair } from "./pairing";

export interface ProposedRecord extends ProposedPair {
  accept: boolean;
}

export function toProposedRecords(pairs: ProposedPair[]): ProposedRecord[] {
  return pairs.map((p) => ({ ...p, accept: true }));
}

export function renderPairsReview(pairs: ProposedPair[]): string {
  if (pairs.length === 0) return "# TM 페어링 검토\n\n제안된 쌍 없음.\n";
  const blocks = pairs.map((p, i) =>
    [
      `## ${i + 1}. ${p.enId} ↔ ${p.koId}  (score ${p.score}: ${p.shared.join(", ")})`,
      "",
      "**EN (원문):**",
      "",
      p.source,
      "",
      "**KO (완성본):**",
      "",
      p.target,
      "",
    ].join("\n"),
  );
  return [
    `# TM 페어링 검토 — ${pairs.length}쌍`,
    "",
    '> 틀린 쌍은 pairs-proposed.json에서 "accept"를 false로 바꾼 뒤 `pnpm tm:promote`.',
    "",
    blocks.join("---\n\n"),
  ].join("\n");
}
```

Create `src/cli/tm-pair.ts`:

```ts
import "./registerErrorHandler";
import { writeFile } from "node:fs/promises";
import { XContentSource } from "../adapters/content/XContentSource";
import { proposePairs } from "../domain/tm/pairing";
import { toProposedRecords, renderPairsReview } from "../domain/tm/pairsReview";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { paths } from "../paths";

// Conservative defaults — precision over recall. Tune from the first real worksheet.
const PAIR_WINDOW_DAYS = 14;
const PAIR_MIN_ANCHORS = 2;

const enItems = await new XContentSource(paths.xItems).loadPending(new Set<string>());
const koItems = await new XContentSource(paths.referenceItems).loadPending(new Set<string>());

const pairs = proposePairs(enItems, koItems, { windowDays: PAIR_WINDOW_DAYS, minAnchors: PAIR_MIN_ANCHORS });

await writeJsonFileAtomic(paths.referenceDir, paths.referencePairsProposed, toProposedRecords(pairs));
await writeFile(paths.referencePairsReview, renderPairsReview(pairs), "utf8");

console.log(
  `proposed ${pairs.length} pair(s). Review ${paths.referencePairsReview}, ` +
    `set "accept": false on wrong pairs in ${paths.referencePairsProposed}, then run: pnpm tm:promote`,
);
```

Add to `package.json` scripts:

```json
    "tm:pair": "tsx src/cli/tm-pair.ts",
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/domain/tm/pairsReview.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/pairsReview.ts src/cli/tm-pair.ts package.json tests/domain/tm/pairsReview.test.ts
git commit -m "feat(tm): tm:pair proposes EN↔KO pairs with a review worksheet"
```

---

### Task 8: `tm:promote` — write accepted pairs into the TM

**Files:**
- Create: `src/domain/tm/promote.ts`
- Create: `src/cli/tm-promote.ts`
- Modify: `package.json` (add `tm:promote` script)
- Test: `tests/domain/tm/promote.test.ts`

**Interfaces:**
- Consumes: `ProposedRecord` (Task 7), `JsonFewShotStore(dir, "tm.json")` (Task 4), `readJsonFile`, `paths` (Task 6).
- Produces: `acceptedRecords(records: ProposedRecord[]): ProposedRecord[]` — keeps records whose `accept !== false`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { acceptedRecords } from "../../../src/domain/tm/promote";
import type { ProposedRecord } from "../../../src/domain/tm/pairsReview";

const rec = (koId: string, accept: boolean): ProposedRecord => ({
  enId: "x:e", koId, score: 2, shared: ["$mnt", "#mantle"], source: "s", target: "t", accept,
});

describe("acceptedRecords", () => {
  it("keeps accept:true, drops accept:false", () => {
    const got = acceptedRecords([rec("x:1", true), rec("x:2", false), rec("x:3", true)]);
    expect(got.map((r) => r.koId)).toEqual(["x:1", "x:3"]);
  });

  it("treats a missing accept flag as accepted", () => {
    const partial = { enId: "x:e", koId: "x:9", score: 2, shared: [], source: "s", target: "t" } as ProposedRecord;
    expect(acceptedRecords([partial])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/tm/promote.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/domain/tm/promote.ts`:

```ts
import type { ProposedRecord } from "./pairsReview";

/** A record is promoted unless the human explicitly set accept:false. */
export function acceptedRecords(records: ProposedRecord[]): ProposedRecord[] {
  return records.filter((r) => r.accept !== false);
}
```

Create `src/cli/tm-promote.ts`:

```ts
import "./registerErrorHandler";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { readJsonFile } from "../shared/store/jsonFile";
import { acceptedRecords } from "../domain/tm/promote";
import type { ProposedRecord } from "../domain/tm/pairsReview";
import { paths } from "../paths";

const records = await readJsonFile<ProposedRecord[]>(paths.referencePairsProposed, []);
const accepted = acceptedRecords(records);

const tm = new JsonFewShotStore(paths.translationConfigDir, "tm.json");
for (const r of accepted) {
  await tm.add({ source: r.source, target: r.target, itemId: r.koId });
}

console.log(`promoted ${accepted.length} of ${records.length} pair(s) → translation/tm.json`);
```

Add to `package.json` scripts:

```json
    "tm:promote": "tsx src/cli/tm-promote.ts",
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/domain/tm/promote.test.ts`
Expected: PASS (2 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/tm/promote.ts src/cli/tm-promote.ts package.json tests/domain/tm/promote.test.ts
git commit -m "feat(tm): tm:promote writes accepted pairs into translation/tm.json"
```

---

### Task 9: Consume the TM in `PrepareTranslations`

**Files:**
- Modify: `src/app/PrepareTranslations.ts`
- Modify: `src/cli/translate-prepare.ts`
- Modify: `tests/app/prepareTranslations.test.ts`

**Interfaces:**
- Consumes: `selectRelevantTm` (Task 3), `FewShotStore`, `JsonFewShotStore(dir, "tm.json")` (Task 4).
- Produces: `PrepareTranslations` constructor gains a `tmStore: FewShotStore` parameter inserted **before** the optional `role` (new signature: `(source, glossaryStore, fewShotStore, config, translationStore, tmStore, role?)`).

- [ ] **Step 1: Write the failing test**

Add to `tests/app/prepareTranslations.test.ts`. First extend the deps helper (near line 17–20) to include a `tmStore`, and update **every** existing `new PrepareTranslations(...)` call in the file to pass `d.tmStore` before the optional role argument (the call at ~line 26 becomes `..., d.translationStore, d.tmStore, "ROLE")`; the calls at ~lines 38/46/55 become `..., d.translationStore, d.tmStore)`). Then add:

```ts
import { selectRelevantTm } from "../../src/domain/tm/selection"; // referenced for intent; not required to import

it("inlines TM pairs relevant to the batch and drops irrelevant ones", async () => {
  const d = makeDeps();
  // one pending item mentioning $MNT / #Mantle
  d.source.loadPending = async () => [
    { id: "x:1", source: "x", text: "$MNT staking live #Mantle", createdAt: "2026-07-20T00:00:00Z" },
  ];
  d.tmStore.load = async () => [
    { source: "$MNT rewards #Mantle", target: "리워드 소식", itemId: "x:a" }, // shares 2 anchors
    { source: "unrelated $OTHER", target: "무관", itemId: "x:b" },            // shares 0
  ];
  const uc = new PrepareTranslations(d.source, d.glossaryStore, d.fewShotStore, d.config, d.translationStore, d.tmStore);
  const { worksheet } = await uc.run({});
  expect(worksheet).toContain("리워드 소식");   // relevant TM pair inlined
  expect(worksheet).not.toContain("무관");       // irrelevant TM pair excluded
});
```

In the deps helper, add:

```ts
const tmStore: FewShotStore = { load: async () => [], add: async () => {} };
// ...and include tmStore in the returned object
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/app/prepareTranslations.test.ts`
Expected: FAIL — `PrepareTranslations` does not accept a `tmStore`, and the worksheet lacks the TM pair (also existing calls will be type-red until updated in Step 3).

- [ ] **Step 3: Implement**

In `src/app/PrepareTranslations.ts`:

```ts
import { selectRelevantTm } from "../domain/tm/selection";
// ...
const MAX_FEW_SHOTS = 8;
const MAX_TM_FEW_SHOTS = 6;

export class PrepareTranslations {
  constructor(
    private readonly source: ContentSource,
    private readonly glossaryStore: GlossaryStore,
    private readonly fewShotStore: FewShotStore,
    private readonly config: TranslationConfig,
    private readonly translationStore: TranslationStore,
    private readonly tmStore: FewShotStore,
    private readonly role: string = DEFAULT_ROLE,
  ) {}

  async run(selector: Selector): Promise<{ worksheet: string; pending: ContentItem[] }> {
    const translatedIds = await this.translationStore.listTranslatedIds();
    let pending = await this.source.loadPending(translatedIds);
    pending = this.applySelector(pending, selector);

    const [glossary, styleGuide, locale, fewShots, tm] = await Promise.all([
      this.glossaryStore.load(),
      this.config.loadStyleGuide(),
      this.config.loadLocale(),
      this.fewShotStore.load(),
      this.tmStore.load(),
    ]);

    const header = assembleSharedContext({
      role: this.role,
      glossary,
      styleGuide,
      locale,
      fewShots: [...fewShots.slice(-MAX_FEW_SHOTS), ...selectRelevantTm(pending, tm, MAX_TM_FEW_SHOTS)],
    });
    const blocks = pending.map((item) => assembleItemBlock(item));
    const worksheet = [header, ...blocks].join("\n");

    return { worksheet, pending };
  }
  // applySelector unchanged
}
```

In `src/cli/translate-prepare.ts`, pass the TM store into the use case (insert as the 6th argument, before any role):

```ts
const usecase = new PrepareTranslations(
  source,
  new JsonGlossaryStore(paths.translationConfigDir),
  new JsonFewShotStore(paths.translationConfigDir),
  new FileTranslationConfig(paths.translationConfigDir),
  new JsonTranslationStore(paths.translationsDir),
  new JsonFewShotStore(paths.translationConfigDir, "tm.json"),
);
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `pnpm test -- tests/app/prepareTranslations.test.ts`
Expected: PASS (existing tests + the new one).
Run: `pnpm test && pnpm typecheck`
Expected: whole suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/PrepareTranslations.ts src/cli/translate-prepare.ts tests/app/prepareTranslations.test.ts
git commit -m "feat(tm): inline relevant TM pairs into the translation worksheet"
```

---

### Task 10: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `docs/ko/capabilities.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`, add:

```markdown
- **Translation memory from @0xMantleKR.** The team's Korean X account publishes translations of
  Mantle_Official's English posts, so the two accounts form real approved EN→KO pairs.
  `pnpm collect:reference` collects @0xMantleKR into an isolated `output/x/reference/` store (never
  the translation queue); `pnpm tm:measure` reports the account's post count and estimated backfill
  cost before a full crawl; `pnpm tm:pair` proposes EN↔KO pairs by shared cashtag/hashtag/mention
  anchors within a temporal window and writes a review worksheet; `pnpm tm:promote` writes the pairs
  a human accepted into `translation/tm.json`. `translate:prepare` now inlines the curated few-shot
  (unchanged) **plus** the TM pairs most relevant to the batch (by same-language anchor overlap),
  replacing the old last-8-by-recency rule. The reference account handle is `REFERENCE_X_HANDLE`
  (default `0xMantleKR`). See `docs/superpowers/specs/2026-07-27-translation-memory-backfill-design.md`.
```

- [ ] **Step 2: Add a capabilities section**

In `docs/ko/capabilities.md`, add a section documenting the four new commands and the flow
(수집 → 측정 → 페어링 제안 → 사람 확인 → 승격 → 번역 프롬프트에 반영). Match the file's existing
heading style and Korean voice. Note explicitly that `translation/tm.json` stays local (public repo)
and that no pair enters the TM without human confirmation.

- [ ] **Step 3: Verify the docs reference real commands**

Run: `grep -nE 'collect:reference|tm:measure|tm:pair|tm:promote' package.json CHANGELOG.md docs/ko/capabilities.md`
Expected: all four scripts appear in `package.json` and are referenced in both docs.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ko/capabilities.md
git commit -m "docs(tm): document the translation-memory backfill commands"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (isolated reference store) → Task 6 (paths + collect:reference; isolation pinned by test).
- Decision 2 (measure-first + incremental) → Task 5 (`tm:measure`) + Task 6 (reuses watermark/ledger via `CollectAuthoredContent`).
- Decision 3 (code candidates → human confirm → promote) → Tasks 2, 7, 8.
- Decision 4 (TM as a second corpus, curated untouched) → Task 4 (store), Task 9 (disjoint budgets `MAX_FEW_SHOTS` + `MAX_TM_FEW_SHOTS`).
- Decision 5 (last-8 → curated + top-K relevant TM) → Task 3 (selection) + Task 9 (consumption).
- Non-goals (align pass, auto-promotion, per-item selection, embeddings, TG/Kakao, articles) → none built; align pass explicitly deferred; selection is per-batch; matching is anchor/lexical only.

**2. Placeholder scan:** No TBD/TODO; every code step has real code. Task 10 Step 2 describes a doc section rather than pasting final prose — acceptable (docs match an existing file's evolving style), and Step 3 verifies the concrete command names landed.

**3. Type consistency:** `ProposedPair` (Task 2) is extended by `ProposedRecord` (Task 7) and consumed by Tasks 8/9-adjacent code; `selectRelevantTm(batch, tm, k)` signature matches its Task 3 definition and Task 9 call; `UserProfile` defined in Task 5 and used by `fetchUserProfile`/`formatMeasureReport`; `JsonFewShotStore(dir, fileName?)` defined in Task 4 and used in Tasks 8/9; `PrepareTranslations` new arg order (`..., translationStore, tmStore, role?`) is applied in both the CLI and the test updates. Consistent.

**Deviation from spec noted:** the spec mentioned a recency tie-break in TM selection; the plan uses a stable sort (input order among equal scores) because `FewShotExample` carries no date and adding one would touch a shared model for a marginal effect. Functionally equivalent for the top-scoring pairs. No other deviations.
