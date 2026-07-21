# Collect Time Bounds + Coverage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--since` / `--limit` flags to `pnpm collect` and record per-run coverage so we can see what time range was swept and what is missing.

**Architecture:** Pure domain helpers (`parseSince`, `applyThreadLimit`, `computeCoverage`) do the reasoning; a new `CollectionRunLedger` port + JSON adapter persists an append-only run log; `CollectAuthoredContent` wires them together and gates watermark advance; the `collect` CLI parses the flags and prints a summary. Storage (`upsert`) is unchanged, so overlapping/ad-hoc re-fetches stay idempotent.

**Tech Stack:** TypeScript (strict, ESM, extension-less imports run via `tsx`), Vitest, Zod (already a dependency — no new deps).

## Global Constraints

- Time axis is `createdAt` (ISO 8601 UTC, always `...Z`). No `updatedAt` / edit handling.
- `--since` accepts relative `Nd` / `Nh` / `Nw` or an ISO date/datetime; normalize to ISO. `m` is NOT accepted (month/minute ambiguity) — throw on it.
- `--limit` is a count of **threads** (assembled タ래), applied after assembly.
- Watermark advances **only** when neither `--since` nor `--limit` is passed. Any flag → ad-hoc run → do not advance.
- Every run (flag-less and ad-hoc) appends one record to `output/x/runs.json`.
- No new npm dependencies. Follow existing file/test idioms (`readJsonFile` / `writeJsonFileAtomic`, `mkdtemp` temp dirs, `describe`/`it` from vitest).

---

### Task 1: `parseSince` time-flag parser

**Files:**
- Create: `src/shared/time/parseSince.ts`
- Test: `tests/shared/time/parseSince.test.ts`

**Interfaces:**
- Produces: `parseSince(value: string, now: Date): string` — returns an ISO 8601 string; throws `Error` on invalid input.

- [ ] **Step 1: Write the failing test**

```ts
// tests/shared/time/parseSince.test.ts
import { describe, it, expect } from "vitest";
import { parseSince } from "../../../src/shared/time/parseSince";

const NOW = new Date("2026-07-21T09:00:00.000Z");

describe("parseSince", () => {
  it("parses relative days", () => {
    expect(parseSince("3d", NOW)).toBe("2026-07-18T09:00:00.000Z");
  });
  it("parses relative hours", () => {
    expect(parseSince("12h", NOW)).toBe("2026-07-20T21:00:00.000Z");
  });
  it("parses relative weeks", () => {
    expect(parseSince("1w", NOW)).toBe("2026-07-14T09:00:00.000Z");
  });
  it("passes through an ISO date (midnight UTC)", () => {
    expect(parseSince("2026-07-18", NOW)).toBe("2026-07-18T00:00:00.000Z");
  });
  it("passes through an ISO datetime", () => {
    expect(parseSince("2026-07-18T09:30:00Z", NOW)).toBe("2026-07-18T09:30:00.000Z");
  });
  it("throws on a bare number with no unit", () => {
    expect(() => parseSince("3", NOW)).toThrow();
  });
  it("throws on an unsupported unit (minutes/months)", () => {
    expect(() => parseSince("5m", NOW)).toThrow();
  });
  it("throws on garbage", () => {
    expect(() => parseSince("banana", NOW)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/shared/time/parseSince.test.ts`
Expected: FAIL — cannot find module `parseSince`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/time/parseSince.ts
const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve a `--since` value to an ISO 8601 string.
 * Relative: `<n><h|d|w>` (e.g. `12h`, `3d`, `1w`) → `now` minus that span.
 * Absolute: any Date-parseable ISO date/datetime, passed through.
 * `m` (minute/month ambiguity) and any other form throw.
 */
export function parseSince(value: string, now: Date): string {
  const rel = /^(\d+)([a-z])$/.exec(value.trim());
  if (rel) {
    const [, n, unit] = rel;
    const ms = UNIT_MS[unit];
    if (ms === undefined) throw new Error(`Unsupported --since unit "${unit}" (use h, d, or w)`);
    return new Date(now.getTime() - Number(n) * ms).toISOString();
  }
  const abs = new Date(value);
  if (Number.isNaN(abs.getTime())) {
    throw new Error(`Invalid --since value "${value}" (use <n>h|d|w or an ISO date)`);
  }
  return abs.toISOString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/shared/time/parseSince.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/time/parseSince.ts tests/shared/time/parseSince.test.ts
git commit -m "feat: parseSince time-flag parser"
```

---

### Task 2: `applyThreadLimit` domain helper

**Files:**
- Create: `src/domain/threadLimit.ts`
- Test: `tests/domain/threadLimit.test.ts`

**Interfaces:**
- Consumes: `AssembledThread` from `src/domain/models` (`{ rootId: string; tweets: SourceTweet[] }`, tweets chronological).
- Produces: `applyThreadLimit(threads: AssembledThread[], limit: number | undefined): { kept: AssembledThread[]; truncated: boolean }` — keeps the newest `limit` threads (by their latest tweet's `createdAt`); `truncated` is true only when threads were dropped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/threadLimit.test.ts
import { describe, it, expect } from "vitest";
import { applyThreadLimit } from "../../src/domain/threadLimit";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, createdAt: string): SourceTweet {
  return { id, conversationId: id, text: `t${id}`, createdAt, url: `u/${id}`,
    authorUserName: "Mantle_Official", isReply: false, isQuote: false };
}
function thread(rootId: string, createdAt: string): AssembledThread {
  return { rootId, tweets: [tw(rootId, createdAt)] };
}

describe("applyThreadLimit", () => {
  const a = thread("a", "2026-07-19T00:00:00.000Z");
  const b = thread("b", "2026-07-20T00:00:00.000Z");
  const c = thread("c", "2026-07-21T00:00:00.000Z");

  it("keeps everything when limit is undefined", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], undefined);
    expect(kept).toHaveLength(3);
    expect(truncated).toBe(false);
  });
  it("keeps everything when limit >= count", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], 3);
    expect(truncated).toBe(false);
    expect(kept).toHaveLength(3);
  });
  it("keeps the newest N and marks truncated", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], 2);
    expect(truncated).toBe(true);
    expect(kept.map((t) => t.rootId)).toEqual(["c", "b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/threadLimit.test.ts`
Expected: FAIL — cannot find module `threadLimit`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/threadLimit.ts
import type { AssembledThread } from "./models";

/** A thread's newest moment = its last (chronological) tweet's createdAt. */
function newestAt(thread: AssembledThread): string {
  return thread.tweets[thread.tweets.length - 1]?.createdAt ?? "";
}

/**
 * Keep the newest `limit` threads (by latest tweet). Applied after assembly so
 * every kept thread is complete. `truncated` is true only when threads are dropped.
 */
export function applyThreadLimit(
  threads: AssembledThread[],
  limit: number | undefined,
): { kept: AssembledThread[]; truncated: boolean } {
  if (limit === undefined || threads.length <= limit) {
    return { kept: threads, truncated: false };
  }
  const sorted = [...threads].sort((x, y) => newestAt(y).localeCompare(newestAt(x)));
  return { kept: sorted.slice(0, limit), truncated: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/threadLimit.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/threadLimit.ts tests/domain/threadLimit.test.ts
git commit -m "feat: applyThreadLimit domain helper"
```

---

### Task 3: `CollectionRun` type + `computeCoverage`

**Files:**
- Create: `src/domain/coverage.ts`
- Test: `tests/domain/coverage.test.ts`

**Interfaces:**
- Consumes: `AssembledThread` from `src/domain/models`.
- Produces:
  - `interface CollectionRun { target: string; ranAt: string; requested: { since: string | null; until: string }; covered: { from: string; to: string } | null; threadCount: number; tweetCount: number; truncated: boolean; gap: { from: string | null; to: string } | null; }`
  - `computeCoverage(threads: AssembledThread[], requested: { since: string | null; until: string }, truncated: boolean): { covered: { from: string; to: string } | null; tweetCount: number; gap: { from: string | null; to: string } | null }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/domain/coverage.test.ts
import { describe, it, expect } from "vitest";
import { computeCoverage } from "../../src/domain/coverage";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, createdAt: string): SourceTweet {
  return { id, conversationId: id, text: `t${id}`, createdAt, url: `u/${id}`,
    authorUserName: "Mantle_Official", isReply: false, isQuote: false };
}
const requested = { since: "2026-07-18T00:00:00.000Z", until: "2026-07-21T09:00:00.000Z" };

describe("computeCoverage", () => {
  it("covers min..max createdAt and reports no gap when not truncated", () => {
    const threads: AssembledThread[] = [
      { rootId: "a", tweets: [tw("a", "2026-07-19T00:00:00.000Z"), tw("a2", "2026-07-19T01:00:00.000Z")] },
      { rootId: "b", tweets: [tw("b", "2026-07-20T00:00:00.000Z")] },
    ];
    const c = computeCoverage(threads, requested, false);
    expect(c.covered).toEqual({ from: "2026-07-19T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" });
    expect(c.tweetCount).toBe(3);
    expect(c.gap).toBeNull();
  });

  it("reports a gap from requested.since to oldest covered when truncated", () => {
    const threads: AssembledThread[] = [
      { rootId: "b", tweets: [tw("b", "2026-07-20T00:00:00.000Z")] },
    ];
    const c = computeCoverage(threads, requested, true);
    expect(c.gap).toEqual({ from: "2026-07-18T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" });
  });

  it("returns null coverage when nothing was kept", () => {
    const c = computeCoverage([], requested, false);
    expect(c.covered).toBeNull();
    expect(c.tweetCount).toBe(0);
    expect(c.gap).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/coverage.test.ts`
Expected: FAIL — cannot find module `coverage`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/coverage.ts
import type { AssembledThread } from "./models";

/** One appended entry in the collection run ledger. */
export interface CollectionRun {
  target: string;
  ranAt: string;
  requested: { since: string | null; until: string };
  covered: { from: string; to: string } | null;
  threadCount: number;
  tweetCount: number;
  truncated: boolean;
  gap: { from: string | null; to: string } | null;
}

/**
 * Derive covered range, tweet count, and any gap from the kept threads.
 * `covered` spans the min..max createdAt of every kept tweet (null if none).
 * `gap` is set only when `truncated`: from the requested floor to the oldest covered.
 */
export function computeCoverage(
  threads: AssembledThread[],
  requested: { since: string | null; until: string },
  truncated: boolean,
): { covered: { from: string; to: string } | null; tweetCount: number; gap: { from: string | null; to: string } | null } {
  const tweets = threads.flatMap((t) => t.tweets);
  if (tweets.length === 0) return { covered: null, tweetCount: 0, gap: null };

  let from = tweets[0].createdAt;
  let to = tweets[0].createdAt;
  for (const t of tweets) {
    if (t.createdAt < from) from = t.createdAt;
    if (t.createdAt > to) to = t.createdAt;
  }
  const gap = truncated ? { from: requested.since, to: from } : null;
  return { covered: { from, to }, tweetCount: tweets.length, gap };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/coverage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/coverage.ts tests/domain/coverage.test.ts
git commit -m "feat: CollectionRun type and computeCoverage"
```

---

### Task 4: `CollectionRunLedger` port + JSON adapter + path

**Files:**
- Create: `src/ports/CollectionRunLedger.ts`
- Create: `src/adapters/store/JsonCollectionRunLedger.ts`
- Modify: `src/paths.ts` (add `xRuns`)
- Test: `tests/adapters/store/jsonCollectionRunLedger.test.ts`

**Interfaces:**
- Consumes: `CollectionRun` from `src/domain/coverage`; `readJsonFile` / `writeJsonFileAtomic` from `src/shared/store/jsonFile`.
- Produces:
  - `interface CollectionRunLedger { record(run: CollectionRun): Promise<void>; }`
  - `class JsonCollectionRunLedger implements CollectionRunLedger` (constructed with the runs file path).
  - `paths.xRuns` = `output/x/runs.json`.

- [ ] **Step 1: Add the runs path**

In `src/paths.ts`, add the `xRuns` entry immediately after `xItems`:

```ts
  xDir: join(OUTPUT_DIR, "x"),
  xItems: join(OUTPUT_DIR, "x", "items.json"),
  xRuns: join(OUTPUT_DIR, "x", "runs.json"),
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/adapters/store/jsonCollectionRunLedger.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCollectionRunLedger } from "../../../src/adapters/store/JsonCollectionRunLedger";
import type { CollectionRun } from "../../../src/domain/coverage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(target: string, ranAt: string): CollectionRun {
  return { target, ranAt, requested: { since: null, until: ranAt }, covered: null,
    threadCount: 0, tweetCount: 0, truncated: false, gap: null };
}

describe("JsonCollectionRunLedger", () => {
  it("appends records in order without clobbering prior ones", async () => {
    const path = join(dir, "runs.json");
    const ledger = new JsonCollectionRunLedger(path);
    await ledger.record(run("Mantle_Official", "2026-07-21T08:00:00.000Z"));
    await ledger.record(run("Mantle_Official", "2026-07-21T09:00:00.000Z"));

    const { readJsonFile } = await import("../../../src/shared/store/jsonFile");
    const all = await readJsonFile<CollectionRun[]>(path, []);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.ranAt)).toEqual([
      "2026-07-21T08:00:00.000Z",
      "2026-07-21T09:00:00.000Z",
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/adapters/store/jsonCollectionRunLedger.test.ts`
Expected: FAIL — cannot find module `JsonCollectionRunLedger`.

- [ ] **Step 4: Write the port**

```ts
// src/ports/CollectionRunLedger.ts
import type { CollectionRun } from "../domain/coverage";

/** Append-only log of collection runs (what range each run covered). */
export interface CollectionRunLedger {
  record(run: CollectionRun): Promise<void>;
}
```

- [ ] **Step 5: Write the adapter**

```ts
// src/adapters/store/JsonCollectionRunLedger.ts
import { dirname } from "node:path";
import type { CollectionRun } from "../../domain/coverage";
import type { CollectionRunLedger } from "../../ports/CollectionRunLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonCollectionRunLedger implements CollectionRunLedger {
  private readonly dir: string;
  constructor(private readonly path: string) {
    this.dir = dirname(path);
  }

  async record(run: CollectionRun): Promise<void> {
    const existing = await readJsonFile<CollectionRun[]>(this.path, []);
    existing.push(run);
    await writeJsonFileAtomic(this.dir, this.path, existing);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm vitest run tests/adapters/store/jsonCollectionRunLedger.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/ports/CollectionRunLedger.ts src/adapters/store/JsonCollectionRunLedger.ts src/paths.ts tests/adapters/store/jsonCollectionRunLedger.test.ts
git commit -m "feat: CollectionRunLedger port, JSON adapter, and runs path"
```

---

### Task 5: Wire options + coverage into `CollectAuthoredContent`

**Files:**
- Modify: `src/app/CollectAuthoredContent.ts`
- Test: `tests/app/collectAuthoredContent.test.ts`

**Interfaces:**
- Consumes: `applyThreadLimit` (Task 2), `computeCoverage` + `CollectionRun` (Task 3), `CollectionRunLedger` (Task 4).
- Produces:
  - `interface CollectOptions { since?: string; limit?: number }`
  - `CollectAuthoredContent` constructor: `(source, repo, watermark, ledger, now = systemClock)`.
  - `run(userName: string, opts?: CollectOptions): Promise<CollectResult>` where `CollectResult` gains `run: CollectionRun`.
  - Behavior: floor = `opts.since ?? watermark.get(userName)`; `truncated`/kept from `applyThreadLimit`; ledger.record every run; watermark advances only when neither flag is set.

- [ ] **Step 1: Update the existing test fixtures and add new cases**

Replace the top of `tests/app/collectAuthoredContent.test.ts` to (a) capture the `sinceTime` the gateway is called with, and (b) add an in-memory ledger. Update the imports and the three fakes:

```ts
import { describe, it, expect } from "vitest";
import { CollectAuthoredContent } from "../../src/app/CollectAuthoredContent";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";
import type { CollectionRunLedger } from "../../src/ports/CollectionRunLedger";
import type { CollectionRun } from "../../src/domain/coverage";
import type { CollectedThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, over: Partial<SourceTweet> = {}): SourceTweet {
  return {
    id,
    conversationId: over.conversationId ?? id,
    text: `t${id}`,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    url: `u/${id}`,
    authorUserName: over.authorUserName ?? "Mantle_Official",
    isReply: over.isReply ?? false,
    isQuote: false,
  };
}

class FakeGateway implements SourceGateway {
  public threadCalls: string[] = [];
  public lastSince: string | undefined;
  constructor(
    private readonly authored: SourceTweet[],
    private readonly threads: Record<string, SourceTweet[]> = {},
  ) {}
  async *fetchAuthoredTweets(_userName: string, sinceTime?: string): AsyncGenerator<SourceTweet> {
    this.lastSince = sinceTime;
    for (const t of this.authored) yield t;
  }
  async fetchThread(id: string): Promise<SourceTweet[]> {
    this.threadCalls.push(id);
    return this.threads[id] ?? [];
  }
  async fetchByIds(): Promise<SourceTweet[]> {
    return [];
  }
}

class InMemoryRepo implements CollectionRepository {
  public saved: CollectedThread[] = [];
  async loadAll() {
    return this.saved;
  }
  async upsert(threads: CollectedThread[]) {
    this.saved = threads;
  }
  async listActiveTweetIds() {
    return [];
  }
  async markDeleted() {}
}

class InMemoryWatermark implements WatermarkStore {
  public marks = new Map<string, string>();
  async get(key: string) {
    return this.marks.get(key);
  }
  async set(key: string, time: string) {
    this.marks.set(key, time);
  }
}

class InMemoryLedger implements CollectionRunLedger {
  public runs: CollectionRun[] = [];
  async record(run: CollectionRun) {
    this.runs.push(run);
  }
}
```

Then update the THREE existing `it(...)` cases to construct with the ledger as the 4th argument (clock stays last):

```ts
  // in "collects, assembles, saves, and advances the watermark to max createdAt"
  const usecase = new CollectAuthoredContent(gw, repo, wm, new InMemoryLedger(), () => "2026-05-05T00:00:00.000Z");

  // in "gap-fills via fetchThread when a thread root is missing from the batch"
  const usecase = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), new InMemoryLedger(), () => "now");

  // in "does not advance the watermark when nothing is fetched"
  const usecase = new CollectAuthoredContent(new FakeGateway([]), new InMemoryRepo(), wm, new InMemoryLedger(), () => "now");
```

Add three new cases inside the `describe` block:

```ts
  it("uses --since as the floor instead of the watermark and does not advance it", async () => {
    const gw = new FakeGateway([tw("1", { createdAt: "2026-01-01T00:05:00.000Z" })]);
    const wm = new InMemoryWatermark();
    wm.marks.set("Mantle_Official", "2020-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), wm, new InMemoryLedger(), () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official", { since: "2026-01-01T00:00:00.000Z" });

    expect(gw.lastSince).toBe("2026-01-01T00:00:00.000Z");
    expect(wm.marks.get("Mantle_Official")).toBe("2020-01-01T00:00:00.000Z"); // unchanged
  });

  it("records a coverage run to the ledger every run", async () => {
    const gw = new FakeGateway([
      tw("1", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("2", { conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" }),
    ]);
    const ledger = new InMemoryLedger();
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), ledger, () => "2026-05-05T00:00:00.000Z");

    await usecase.run("Mantle_Official");

    expect(ledger.runs).toHaveLength(1);
    expect(ledger.runs[0]).toMatchObject({
      target: "Mantle_Official",
      ranAt: "2026-05-05T00:00:00.000Z",
      covered: { from: "2026-01-01T00:01:00.000Z", to: "2026-01-01T00:02:00.000Z" },
      threadCount: 1,
      tweetCount: 2,
      truncated: false,
      gap: null,
    });
  });

  it("applies --limit keeping newest N threads and records a gap", async () => {
    const gw = new FakeGateway([
      tw("a", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("b", { createdAt: "2026-01-02T00:01:00.000Z" }),
      tw("c", { createdAt: "2026-01-03T00:01:00.000Z" }),
    ]);
    const repo = new InMemoryRepo();
    const ledger = new InMemoryLedger();
    const usecase = new CollectAuthoredContent(gw, repo, new InMemoryWatermark(), ledger, () => "2026-05-05T00:00:00.000Z");

    const result = await usecase.run("Mantle_Official", { since: "2026-01-01T00:00:00.000Z", limit: 2 });

    expect(result.threadCount).toBe(2);
    expect(repo.saved.map((t) => t.rootId).sort()).toEqual(["b", "c"]);
    expect(ledger.runs[0].truncated).toBe(true);
    expect(ledger.runs[0].gap).toEqual({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:01:00.000Z" });
  });
```

- [ ] **Step 2: Run tests to verify the new/updated cases fail**

Run: `pnpm vitest run tests/app/collectAuthoredContent.test.ts`
Expected: FAIL — constructor arity / `run` options / `ledger` not yet supported.

- [ ] **Step 3: Rewrite `CollectAuthoredContent.ts`**

```ts
// src/app/CollectAuthoredContent.ts
import { assembleThreads } from "../domain/threadAssembler";
import type { CollectedThread, SourceTweet } from "../domain/models";
import { applyThreadLimit } from "../domain/threadLimit";
import { computeCoverage, type CollectionRun } from "../domain/coverage";
import type { SourceGateway } from "../ports/SourceGateway";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { CollectionRunLedger } from "../ports/CollectionRunLedger";
import type { WatermarkStore } from "../shared/store/WatermarkStore";
import { systemClock, type Clock } from "../ports/Clock";

export interface CollectOptions {
  since?: string;
  limit?: number;
}

export interface CollectResult {
  fetchedCount: number;
  threadCount: number;
  run: CollectionRun;
}

export class CollectAuthoredContent {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly watermark: WatermarkStore,
    private readonly ledger: CollectionRunLedger,
    private readonly now: Clock = systemClock,
  ) {}

  async run(userName: string, opts: CollectOptions = {}): Promise<CollectResult> {
    const adhoc = opts.since !== undefined || opts.limit !== undefined;
    const floor = opts.since ?? (await this.watermark.get(userName));

    const fetched: SourceTweet[] = [];
    for await (const t of this.source.fetchAuthoredTweets(userName, floor)) fetched.push(t);

    await this.gapFillMissingRoots(fetched, userName);

    const assembled = assembleThreads(fetched);
    const { kept, truncated } = applyThreadLimit(assembled, opts.limit);

    const ranAt = this.now();
    const collected: CollectedThread[] = kept.map((thread) => ({
      rootId: thread.rootId,
      tweets: thread.tweets,
      status: "active",
      firstSeenAt: ranAt,
    }));
    await this.repo.upsert(collected);

    const requested = { since: floor ?? null, until: ranAt };
    const coverage = computeCoverage(kept, requested, truncated);
    const run: CollectionRun = {
      target: userName,
      ranAt,
      requested,
      covered: coverage.covered,
      threadCount: kept.length,
      tweetCount: coverage.tweetCount,
      truncated,
      gap: coverage.gap,
    };
    await this.ledger.record(run);

    if (!adhoc) {
      const maxCreatedAt = this.maxCreatedAt(fetched);
      if (maxCreatedAt && (!floor || maxCreatedAt > floor)) {
        await this.watermark.set(userName, maxCreatedAt);
      }
    }

    return { fetchedCount: fetched.length, threadCount: kept.length, run };
  }

  /** Pull earlier thread parts (via thread_context) for threads whose root is absent. */
  private async gapFillMissingRoots(fetched: SourceTweet[], userName: string): Promise<void> {
    const presentIds = new Set(fetched.map((t) => t.id));
    const missingRoots = new Set<string>();
    for (const t of fetched) {
      if (t.conversationId !== t.id && !presentIds.has(t.conversationId)) {
        missingRoots.add(t.conversationId);
      }
    }
    for (const rootId of missingRoots) {
      const threadTweets = await this.source.fetchThread(rootId);
      for (const t of threadTweets) {
        if (t.authorUserName === userName && !presentIds.has(t.id)) {
          fetched.push(t);
          presentIds.add(t.id);
        }
      }
    }
  }

  private maxCreatedAt(tweets: SourceTweet[]): string | undefined {
    let max: string | undefined;
    for (const t of tweets) {
      if (!max || t.createdAt > max) max = t.createdAt;
    }
    return max;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/app/collectAuthoredContent.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/CollectAuthoredContent.ts tests/app/collectAuthoredContent.test.ts
git commit -m "feat: collect options, thread limit, and coverage ledger in usecase"
```

---

### Task 6: Wire flags into the `collect` CLI

**Files:**
- Modify: `src/cli/collect.ts`

**Interfaces:**
- Consumes: `parseSince` (Task 1), `CollectAuthoredContent` + `CollectOptions` (Task 5), `JsonCollectionRunLedger` (Task 4), `paths.xRuns` (Task 4), `argValue` from `src/cli/args`.

- [ ] **Step 1: Rewrite `collect.ts`**

```ts
// src/cli/collect.ts
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

const target = process.argv[2]?.startsWith("--") ? "Mantle_Official" : process.argv[2] ?? "Mantle_Official";

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
const store = new LocalJsonStore(paths.xDir);
const ledger = new JsonCollectionRunLedger(paths.xRuns);
const usecase = new CollectAuthoredContent(source, store, store, ledger);

const { run } = await usecase.run(target, opts);

const cov = run.covered ? `covered ${run.covered.from} ~ ${run.covered.to}` : "nothing new in window";
const gap = run.gap ? `, GAP ${run.gap.from ?? "(open)"} ~ ${run.gap.to} (limit reached)` : "";
console.log(
  `collected ${run.threadCount} threads (${run.tweetCount} tweets) for @${target} — ${cov}${gap}`,
);
```

- [ ] **Step 2: Typecheck the whole project**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites green, including the new files.

- [ ] **Step 4: Manual smoke check of flag parsing (no network)**

Run: `pnpm collect --since 3d --limit 5` only if API credentials are present; otherwise verify parsing by running `pnpm collect Mantle_Official --since 3d --limit 5` and confirming it reaches the network call (an auth/credentials error is acceptable proof the flags parsed). Do NOT commit any generated `output/x/runs.json`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/collect.ts
git commit -m "feat: --since and --limit flags on the collect CLI"
```

---

## Self-Review

**1. Spec coverage**
- `--since` floor (relative + ISO): Task 1 (`parseSince`) + Task 6 (wiring). ✓
- `--limit` = threads, post-assembly truncation: Task 2 + Task 5. ✓
- Watermark override + non-advance on any flag: Task 5 (`adhoc` gate) + test. ✓
- Coverage record shape (requested/covered/truncated/gap/counts): Task 3 + Task 5. ✓
- Ledger at `output/x/runs.json`, all runs: Task 4 (path + adapter) + Task 5 (record every run). ✓
- Console summary: Task 6. ✓
- `createdAt` axis / no edit handling: enforced by only ever reading `createdAt`; edits explicitly out of scope. ✓
- Storage upsert unchanged / idempotent overlap: untouched; sliding-window automation relies on it. ✓
- Recommended hourly `--since 2h` pattern: documented in the spec; no code needed (it's just flag usage). ✓
- Known limitations (growth, no lock): documented in spec; out of code scope. ✓

**2. Placeholder scan:** No TBD/TODO; every code step contains full code; every command has expected output. ✓

**3. Type consistency:** `CollectionRun` shape is identical across Task 3 (definition), Task 4 (port/adapter), Task 5 (usecase), Task 6 (CLI). `applyThreadLimit` returns `{ kept, truncated }` (Task 2) and is consumed with those names in Task 5. `computeCoverage` returns `{ covered, tweetCount, gap }` (Task 3) and is destructured with those names in Task 5. Constructor order `(source, repo, watermark, ledger, now)` is used consistently in Task 5 impl and all Task 5 test constructions. ✓
