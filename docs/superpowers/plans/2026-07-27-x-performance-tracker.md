# X Performance Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each month, fetch X performance (followers, posts, views, engagement) for the KR official account (@0xMantleKR) and the X-based KOLs listed in the team's Q3 workbook, and upsert one row per account into a machine-owned `x-performance` tab in that workbook.

**Architecture:** A `metrics:record` CLI reads the human `KOL list` roster (X rows only) via the existing `SheetClient`, then for each account fetches its follower count + that month's authored tweets via the existing `SourceGateway`, aggregates them with a pure domain function, and upserts a row keyed by `(account, month)` into `x-performance`. Raw numbers only; derived ratios/cost stay as spreadsheet formulas. Human tabs are read-only to the pipeline.

**Tech Stack:** TypeScript (ESM, `tsx`), Node built-ins, `zod` (schema parsing), `vitest`. No new runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-27-x-performance-tracker-design.md`

## Global Constraints

- **Runtime dependencies stay zod-only.** No new npm runtime deps.
- **Cloud-only feature.** `metrics:record` is `skipIfLocal`-gated; a live run needs `HERALD_STORAGE_MODE=cloud`, the OAuth `spreadsheets` scope, and `GSHEET_ID` = the team Q3 workbook. (These are operator prerequisites, not code.)
- **Public repo — synthetic test data only.** Never put real KOL names, handles, emails, or numbers from the workbook into the repo. `*.xlsx` is git-ignored.
- **The writer touches only the `x-performance` tab.** It reads `'KOL list'` and never writes the roster, contract, monthly, or cost columns.
- **Follow existing patterns.** Pure logic in `src/domain/`, tested in isolation; the upsert mirrors `src/app/RecordPublish.ts`; the CLI is thin wiring; API CLIs run with `tsx --env-file-if-exists=.env`.
- **Every test must be able to fail.** Pin each assertion; mutation-check.

---

### Task 1: `UserProfile.followers` + promote `fetchUserProfile` to the `SourceGateway` port

**Files:**
- Modify: `src/domain/models.ts` (add `followers` to `UserProfile`)
- Modify: `src/adapters/twitterapi/schemas.ts` (`parseUserProfile` captures `followers`)
- Modify: `src/ports/SourceGateway.ts` (add `fetchUserProfile` to the interface)
- Modify: `tests/adapters/parseUserProfile.test.ts` (assert `followers`)
- Modify (add a no-op `fetchUserProfile` to each SourceGateway stub): `tests/app/collectAuthoredContent.test.ts`, `tests/app/reconcileDeletions.test.ts`, `tests/app/recordImpressions.test.ts`

**Interfaces:**
- Consumes: existing `parseUserProfile`, `TwitterApiSourceGateway.fetchUserProfile` (already implemented).
- Produces: `UserProfile { userName: string; statusesCount?: number; followers?: number }`; `SourceGateway.fetchUserProfile(userName: string): Promise<UserProfile>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/parseUserProfile.test.ts`:

```ts
it("captures followers when present, undefined when absent", () => {
  expect(parseUserProfile({ data: { userName: "0xMantleKR", statusesCount: 4317, followers: 4164 } }, "fb"))
    .toEqual({ userName: "0xMantleKR", statusesCount: 4317, followers: 4164 });
  expect(parseUserProfile({ data: { userName: "0xMantleKR" } }, "fb"))
    .toEqual({ userName: "0xMantleKR", statusesCount: undefined, followers: undefined });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/parseUserProfile.test.ts`
Expected: FAIL — `followers` is not on the returned object.

- [ ] **Step 3: Implement**

In `src/domain/models.ts`, extend `UserProfile`:

```ts
export interface UserProfile {
  userName: string;
  statusesCount?: number;
  followers?: number;
}
```

In `src/adapters/twitterapi/schemas.ts`, extend the schema + the returned object (keep `.passthrough()`):

```ts
const UserProfileData = z
  .object({ userName: z.string().optional(), statusesCount: z.number().optional(), followers: z.number().optional() })
  .passthrough();
```

and in `parseUserProfile`'s return:

```ts
  return {
    userName: d.userName ?? fallbackUserName,
    statusesCount: typeof d.statusesCount === "number" ? d.statusesCount : undefined,
    followers: typeof d.followers === "number" ? d.followers : undefined,
  };
```

In `src/ports/SourceGateway.ts`, add to the interface (with the others):

```ts
  /** Account profile (followers / statusesCount) for a handle. */
  fetchUserProfile(userName: string): Promise<UserProfile>;
```

and widen the file's import to include `UserProfile`:

```ts
import type { ArticleBlock, SourceTweet, UserProfile } from "../domain/models";
```

`TwitterApiSourceGateway` already implements `fetchUserProfile`, so no adapter change is needed.

Add a no-op stub method to each SourceGateway literal in the three test files (place it beside the existing `fetchByIds`/`fetchArticle` stubs):

```ts
    fetchUserProfile: async () => ({ userName: "stub" }),
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `pnpm test -- tests/adapters/parseUserProfile.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: clean. If it flags another file constructing a `SourceGateway`, add the same one-line stub there.
Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/domain/models.ts src/adapters/twitterapi/schemas.ts src/ports/SourceGateway.ts tests/adapters/parseUserProfile.test.ts tests/app/collectAuthoredContent.test.ts tests/app/reconcileDeletions.test.ts tests/app/recordImpressions.test.ts
git commit -m "feat(metrics): add followers to UserProfile and promote fetchUserProfile to the port"
```

---

### Task 2: `SheetClient.ensureTab`

**Files:**
- Modify: `src/ports/SheetClient.ts` (add `ensureTab`)
- Modify: `src/adapters/sheets/GoogleSheetClient.ts` (implement `ensureTab`)
- Modify: `tests/adapters/sheets/googleSheetClient.test.ts` (test `ensureTab`)
- Modify (add a no-op `ensureTab` to each SheetClient fake): `tests/app/loadTargets.test.ts`, `tests/app/recordPublish.test.ts`, `tests/app/recordImpressions.test.ts`

**Interfaces:**
- Produces: `SheetClient.ensureTab(title: string): Promise<void>` — creates the tab if absent, no-op if present.

- [ ] **Step 1: Write the failing test**

Add to `tests/adapters/sheets/googleSheetClient.test.ts` (this suite drives `GoogleSheetClient` with an injected `fetchFn`; follow the existing style there):

```ts
it("ensureTab creates the tab only when it is absent", async () => {
  const calls: { url: string; method?: string }[] = [];
  const fetchFn = (async (url: string, init?: { method?: string }) => {
    calls.push({ url: String(url), method: init?.method });
    if (String(url).includes("?fields=sheets.properties.title")) {
      return { ok: true, json: async () => ({ sheets: [{ properties: { title: "targets" } }] }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  const c = new GoogleSheetClient({ getToken: async () => "tok" }, "SID", fetchFn);
  await c.ensureTab("x-performance"); // absent → must batchUpdate
  expect(calls.some((x) => x.url.includes(":batchUpdate") && x.method === "POST")).toBe(true);

  calls.length = 0;
  await c.ensureTab("targets"); // present → must NOT batchUpdate
  expect(calls.some((x) => x.url.includes(":batchUpdate"))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/sheets/googleSheetClient.test.ts`
Expected: FAIL — `ensureTab` does not exist.

- [ ] **Step 3: Implement**

In `src/ports/SheetClient.ts`, add to the interface:

```ts
  /** Create a tab if it does not already exist (no-op when present). */
  ensureTab(title: string): Promise<void>;
```

In `src/adapters/sheets/GoogleSheetClient.ts`, add the method (uses the same `BASE`, `headers()`, `fetchFn`):

```ts
  async ensureTab(title: string): Promise<void> {
    const metaUrl = `${BASE}/${this.spreadsheetId}?fields=sheets.properties.title`;
    const metaRes = await this.fetchFn(metaUrl, { method: "GET", headers: await this.headers() });
    if (!metaRes.ok) throw new Error(`Sheets get metadata failed: HTTP ${metaRes.status}`);
    const meta = (await metaRes.json()) as { sheets?: { properties?: { title?: string } }[] };
    const exists = (meta.sheets ?? []).some((s) => s.properties?.title === title);
    if (exists) return;
    const res = await this.fetchFn(`${BASE}/${this.spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
    if (!res.ok) throw new Error(`Sheets addSheet failed: HTTP ${res.status}`);
  }
```

Add `ensureTab: async () => {},` to the SheetClient fake object in each of `tests/app/loadTargets.test.ts`, `tests/app/recordPublish.test.ts`, `tests/app/recordImpressions.test.ts`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test -- tests/adapters/sheets/googleSheetClient.test.ts`
Expected: PASS.
Run: `pnpm typecheck && pnpm test`
Expected: clean + full suite green. If typecheck flags another SheetClient literal, add the same one-line `ensureTab` stub there.

- [ ] **Step 5: Commit**

```bash
git add src/ports/SheetClient.ts src/adapters/sheets/GoogleSheetClient.ts tests/adapters/sheets/googleSheetClient.test.ts tests/app/loadTargets.test.ts tests/app/recordPublish.test.ts tests/app/recordImpressions.test.ts
git commit -m "feat(metrics): SheetClient.ensureTab creates a tab when absent"
```

---

### Task 3: month window helpers

**Files:**
- Create: `src/domain/metrics/window.ts`
- Test: `tests/domain/metrics/window.test.ts`

**Interfaces:**
- Produces:
  - `currentMonth(now: Date): string` — `"YYYY-MM"` in UTC.
  - `interface MonthWindow { month: string; startISO: string; endExclusiveISO: string }`
  - `monthWindow(month: string): MonthWindow` — throws on a non-`YYYY-MM` or out-of-range month.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { currentMonth, monthWindow } from "../../../src/domain/metrics/window";

describe("currentMonth", () => {
  it("formats YYYY-MM in UTC", () => {
    expect(currentMonth(new Date("2026-07-15T09:00:00Z"))).toBe("2026-07");
    expect(currentMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("monthWindow", () => {
  it("returns the UTC month bounds, end exclusive", () => {
    expect(monthWindow("2026-07")).toEqual({
      month: "2026-07",
      startISO: "2026-07-01T00:00:00.000Z",
      endExclusiveISO: "2026-08-01T00:00:00.000Z",
    });
  });
  it("rolls December into next January", () => {
    expect(monthWindow("2026-12").endExclusiveISO).toBe("2027-01-01T00:00:00.000Z");
  });
  it("rejects a malformed or out-of-range month", () => {
    expect(() => monthWindow("2026-7")).toThrow();
    expect(() => monthWindow("2026-13")).toThrow();
    expect(() => monthWindow("nope")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/metrics/window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/metrics/window.ts
export function currentMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export interface MonthWindow {
  month: string;
  startISO: string;
  endExclusiveISO: string;
}

export function monthWindow(month: string): MonthWindow {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month "${month}" (expected YYYY-MM)`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`Invalid month "${month}" (month must be 01-12)`);
  return {
    month,
    startISO: new Date(Date.UTC(year, mon - 1, 1)).toISOString(),
    endExclusiveISO: new Date(Date.UTC(year, mon, 1)).toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/metrics/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/metrics/window.ts tests/domain/metrics/window.test.ts
git commit -m "feat(metrics): month window helpers (UTC bounds, end-exclusive)"
```

---

### Task 4: `aggregateMonth`

**Files:**
- Create: `src/domain/metrics/aggregate.ts`
- Test: `tests/domain/metrics/aggregate.test.ts`

**Interfaces:**
- Consumes: `SourceTweet` from `src/domain/models.ts` (`{ createdAt: string; metrics?: { likeCount?, retweetCount?, replyCount?, quoteCount?, viewCount? } }`); `MonthWindow` (Task 3).
- Produces: `interface MonthAggregate { posts: number; views: number; engagement: number }`; `aggregateMonth(tweets: SourceTweet[], window: MonthWindow): MonthAggregate`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { aggregateMonth } from "../../../src/domain/metrics/aggregate";
import type { MonthWindow } from "../../../src/domain/metrics/window";
import type { SourceTweet } from "../../../src/domain/models";

const win: MonthWindow = { month: "2026-07", startISO: "2026-07-01T00:00:00.000Z", endExclusiveISO: "2026-08-01T00:00:00.000Z" };
const tw = (createdAt: string, metrics?: SourceTweet["metrics"]): SourceTweet =>
  ({ id: "1", conversationId: "1", createdAt, text: "", metrics } as SourceTweet);

describe("aggregateMonth", () => {
  it("counts posts and sums views + engagement within the window", () => {
    const got = aggregateMonth(
      [
        tw("2026-07-05T00:00:00.000Z", { viewCount: 100, likeCount: 3, retweetCount: 2, replyCount: 1, quoteCount: 1 }),
        tw("2026-07-20T00:00:00.000Z", { viewCount: 50, likeCount: 1 }),
      ],
      win,
    );
    expect(got).toEqual({ posts: 2, views: 150, engagement: 8 }); // 7 + 1
  });
  it("excludes tweets outside the window", () => {
    const got = aggregateMonth([tw("2026-06-30T23:59:59.000Z", { viewCount: 999 }), tw("2026-08-01T00:00:00.000Z", { viewCount: 999 })], win);
    expect(got).toEqual({ posts: 0, views: 0, engagement: 0 });
  });
  it("treats missing metric fields as zero", () => {
    expect(aggregateMonth([tw("2026-07-10T00:00:00.000Z")], win)).toEqual({ posts: 1, views: 0, engagement: 0 });
  });
  it("returns zeros for empty input", () => {
    expect(aggregateMonth([], win)).toEqual({ posts: 0, views: 0, engagement: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/metrics/aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/metrics/aggregate.ts
import type { SourceTweet } from "../models";
import type { MonthWindow } from "./window";

export interface MonthAggregate {
  posts: number;
  views: number;
  engagement: number;
}

export function aggregateMonth(tweets: SourceTweet[], window: MonthWindow): MonthAggregate {
  let posts = 0;
  let views = 0;
  let engagement = 0;
  for (const t of tweets) {
    if (t.createdAt < window.startISO || t.createdAt >= window.endExclusiveISO) continue;
    posts += 1;
    const m = t.metrics ?? {};
    views += m.viewCount ?? 0;
    engagement += (m.likeCount ?? 0) + (m.retweetCount ?? 0) + (m.replyCount ?? 0) + (m.quoteCount ?? 0);
  }
  return { posts, views, engagement };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/metrics/aggregate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/metrics/aggregate.ts tests/domain/metrics/aggregate.test.ts
git commit -m "feat(metrics): aggregate a month's tweets into posts/views/engagement"
```

---

### Task 5: `extractXHandle`

**Files:**
- Create: `src/domain/metrics/handles.ts`
- Test: `tests/domain/metrics/handles.test.ts`

**Interfaces:**
- Produces: `extractXHandle(platform: string, link: string): string | undefined` — an X handle (no `@`, ≤15 chars) when the platform is X/Twitter and the link resolves; otherwise `undefined`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractXHandle } from "../../../src/domain/metrics/handles";

describe("extractXHandle", () => {
  it("resolves an x.com / twitter.com URL when platform is X/Twitter", () => {
    expect(extractXHandle("X", "https://x.com/Mantle_KR")).toBe("Mantle_KR");
    expect(extractXHandle("Twitter", "https://twitter.com/foo?ref=1")).toBe("foo");
    expect(extractXHandle("x", "https://www.x.com/bar/")).toBe("bar");
  });
  it("resolves a bare @handle / handle when platform is X", () => {
    expect(extractXHandle("X", "@baz")).toBe("baz");
    expect(extractXHandle("X", "qux")).toBe("qux");
  });
  it("returns undefined when the platform is not X", () => {
    expect(extractXHandle("Telegram", "https://x.com/foo")).toBeUndefined();
  });
  it("returns undefined for a blank or non-X link", () => {
    expect(extractXHandle("X", "")).toBeUndefined();
    expect(extractXHandle("X", "https://t.me/foo")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/metrics/handles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/metrics/handles.ts

/** An X handle (no @, ≤15 chars) when this roster row is an X account, else undefined. */
export function extractXHandle(platform: string, link: string): string | undefined {
  if (!/^\s*(x|twitter)\s*$/i.test(platform)) return undefined;
  const s = (link ?? "").trim();
  if (s === "") return undefined;
  const url = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i.exec(s);
  if (url) return url[1];
  const bare = /^@?([A-Za-z0-9_]{1,15})$/.exec(s);
  if (bare) return bare[1];
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/metrics/handles.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/metrics/handles.ts tests/domain/metrics/handles.test.ts
git commit -m "feat(metrics): resolve an X handle from a roster row"
```

---

### Task 6: `LoadRoster`

**Files:**
- Modify: `src/domain/sheet/models.ts` (add `RosterEntry`)
- Create: `src/app/LoadRoster.ts`
- Test: `tests/app/loadRoster.test.ts`

**Interfaces:**
- Consumes: `SheetClient.getValues` (Task 2 port); `extractXHandle` (Task 5).
- Produces: `interface RosterEntry { name: string; handle: string }`; `LoadRoster.run(): Promise<RosterEntry[]>` — the X-resolvable KOLs from `'KOL list'`, skipping everything else.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { LoadRoster } from "../../src/app/LoadRoster";
import type { SheetClient } from "../../src/ports/SheetClient";

function sheet(rows: string[][]): SheetClient {
  return {
    getValues: async () => rows,
    appendValues: async () => {},
    updateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
}

describe("LoadRoster", () => {
  it("returns X KOLs by header name (any column order), skipping non-X and section rows", async () => {
    // header order deliberately not A=KOL to prove name-based mapping
    const rows = [
      ["Social media", "KOL", "Note", "Social media link"],
      ["", "In contract", "", ""],                          // section row → skip (no handle)
      ["X", "Marine", "", "https://x.com/marine_x"],        // keep
      ["Telegram", "Coinboy", "", "https://t.me/coinboy"],  // skip (not X)
      ["X", "BadLink", "", ""],                             // skip (blank link)
    ];
    const got = await new LoadRoster(sheet(rows)).run();
    expect(got).toEqual([{ name: "Marine", handle: "marine_x" }]);
  });

  it("throws when a required column is missing", async () => {
    await expect(new LoadRoster(sheet([["KOL", "Note"]])).run()).rejects.toThrow(/Social media/);
  });

  it("returns [] for an empty sheet", async () => {
    expect(await new LoadRoster(sheet([])).run()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/app/loadRoster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `src/domain/sheet/models.ts`:

```ts
export interface RosterEntry {
  name: string;
  handle: string; // X handle without @
}
```

Create `src/app/LoadRoster.ts`:

```ts
import type { SheetClient } from "../ports/SheetClient";
import type { RosterEntry } from "../domain/sheet/models";
import { extractXHandle } from "../domain/metrics/handles";

// The roster tab + column headers are coupled to the team workbook; update here if renamed.
const ROSTER_RANGE = "'KOL list'!A:Z";
const COL_NAME = "kol";
const COL_PLATFORM = "social media";
const COL_LINK = "social media link";

export class LoadRoster {
  constructor(private readonly sheet: SheetClient) {}

  async run(): Promise<RosterEntry[]> {
    const rows = await this.sheet.getValues(ROSTER_RANGE);
    if (rows.length === 0) return [];
    const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
    const nameIdx = header.indexOf(COL_NAME);
    const platIdx = header.indexOf(COL_PLATFORM);
    const linkIdx = header.indexOf(COL_LINK);
    if (nameIdx < 0 || platIdx < 0 || linkIdx < 0) {
      throw new Error(`'KOL list' is missing a required column (need "KOL", "Social media", "Social media link")`);
    }
    const out: RosterEntry[] = [];
    for (const row of rows.slice(1)) {
      const name = (row[nameIdx] ?? "").trim();
      const handle = extractXHandle(row[platIdx] ?? "", row[linkIdx] ?? "");
      if (name && handle) out.push({ name, handle });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/app/loadRoster.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/sheet/models.ts src/app/LoadRoster.ts tests/app/loadRoster.test.ts
git commit -m "feat(metrics): LoadRoster reads X KOLs from the KOL list tab by header name"
```

---

### Task 7: `RecordMetrics`

**Files:**
- Modify: `src/domain/sheet/models.ts` (add `X_PERFORMANCE_HEADER`)
- Create: `src/app/RecordMetrics.ts`
- Test: `tests/app/recordMetrics.test.ts`

**Interfaces:**
- Consumes: `SheetClient` (`ensureTab`/`getValues`/`updateValues`/`appendValues`), `SourceGateway` (`fetchUserProfile`/`fetchAuthoredTweets`), `aggregateMonth` (Task 4), `monthWindow` (Task 3), `RosterEntry` (Task 6).
- Produces:
  - `const X_PERFORMANCE_HEADER = ["account","name","type","month","followers","posts","views","engagement","fetchedAt"]`
  - `interface RecordMetricsInput { month: string; officialHandle: string; roster: RosterEntry[] }`
  - `interface RecordMetricsResult { recorded: number; skipped: number }`
  - `RecordMetrics.run(input): Promise<RecordMetricsResult>` — upserts one `x-performance` row per account, keyed by `(account, month)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { RecordMetrics } from "../../src/app/RecordMetrics";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { SourceTweet, UserProfile } from "../../src/domain/models";

function fakeSheet() {
  const state: { rows: string[][]; ensured: string[]; appended: string[][]; updated: { range: string; row: string[] }[] } =
    { rows: [], ensured: [], appended: [], updated: [] };
  const sheet: SheetClient = {
    ensureTab: async (t) => { state.ensured.push(t); },
    getValues: async (range) => (range.endsWith("A1:I1") ? (state.rows[0] ? [state.rows[0]] : []) : state.rows.slice(1)),
    appendValues: async (_r, rows) => { for (const row of rows) { state.rows.push(row); state.appended.push(row); } },
    updateValues: async (range, rows) => {
      state.updated.push({ range, row: rows[0] });
      if (range.endsWith("A1:I1")) { state.rows[0] = rows[0]; return; }
      const m = /A(\d+):I\1$/.exec(range);
      if (m) state.rows[Number(m[1]) - 1] = rows[0];
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, state };
}

function gateway(followersByHandle: Record<string, number>, tweetsByHandle: Record<string, SourceTweet[]>): SourceGateway {
  const tw = (h: string) => (async function* () { for (const t of tweetsByHandle[h] ?? []) yield t; })();
  return {
    fetchUserProfile: async (h): Promise<UserProfile> => ({ userName: h, followers: followersByHandle[h] }),
    fetchAuthoredTweets: (h: string) => tw(h) as ReturnType<SourceGateway["fetchAuthoredTweets"]>,
    fetchThread: async () => [],
    fetchByIds: async () => [],
    fetchArticle: async () => [],
  };
}

const tweet = (createdAt: string, viewCount: number): SourceTweet =>
  ({ id: "1", conversationId: "1", createdAt, text: "", metrics: { viewCount, likeCount: 1 } } as SourceTweet);

describe("RecordMetrics", () => {
  it("writes the header once, then one row for the official account + each roster KOL", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway(
      { "0xMantleKR": 4164, marine_x: 2000 },
      {
        "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 100), tweet("2026-07-06T00:00:00.000Z", 50)],
        marine_x: [tweet("2026-07-10T00:00:00.000Z", 10)],
      },
    );
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    const res = await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [{ name: "Marine", handle: "marine_x" }] });

    expect(res).toEqual({ recorded: 2, skipped: 0 });
    expect(state.ensured).toContain("x-performance");
    expect(state.rows[0]).toEqual(["account", "name", "type", "month", "followers", "posts", "views", "engagement", "fetchedAt"]);
    // official row: 2 posts, views 150, engagement 2
    expect(state.rows[1]).toEqual(["0xMantleKR", "Mantle KR", "official", "2026-07", "4164", "2", "150", "2", "2026-07-31T00:00:00.000Z"]);
    // kol row: 1 post, views 10, engagement 1
    expect(state.rows[2]).toEqual(["marine_x", "Marine", "kol", "2026-07", "2000", "1", "10", "1", "2026-07-31T00:00:00.000Z"]);
  });

  it("upserts: a second run for the same (account, month) overwrites, not appends", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ "0xMantleKR": 1 }, { "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 10)] });
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [] });
    await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [] });
    const dataRows = state.rows.slice(1);
    expect(dataRows.filter((r) => r[0] === "0xMantleKR" && r[3] === "2026-07")).toHaveLength(1);
  });

  it("skips an account whose fetch throws and records the rest", async () => {
    const { sheet, state } = fakeSheet();
    const base = gateway({ "0xMantleKR": 1 }, { "0xMantleKR": [tweet("2026-07-05T00:00:00.000Z", 10)] });
    const gw: SourceGateway = { ...base, fetchUserProfile: async (h) => { if (h === "boom") throw new Error("HTTP 500"); return { userName: h, followers: 1 }; } };
    const uc = new RecordMetrics(sheet, gw, () => new Date("2026-07-31T00:00:00.000Z"));
    const res = await uc.run({ month: "2026-07", officialHandle: "0xMantleKR", roster: [{ name: "Boom", handle: "boom" }] });
    expect(res).toEqual({ recorded: 1, skipped: 1 });
    expect(state.rows.slice(1).map((r) => r[0])).toEqual(["0xMantleKR"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/app/recordMetrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Add to `src/domain/sheet/models.ts`:

```ts
export const X_PERFORMANCE_HEADER = ["account", "name", "type", "month", "followers", "posts", "views", "engagement", "fetchedAt"];
```

Create `src/app/RecordMetrics.ts`:

```ts
import type { SheetClient } from "../ports/SheetClient";
import type { SourceGateway } from "../ports/SourceGateway";
import type { SourceTweet } from "../domain/models";
import type { RosterEntry } from "../domain/sheet/models";
import { X_PERFORMANCE_HEADER } from "../domain/sheet/models";
import { aggregateMonth } from "../domain/metrics/aggregate";
import { monthWindow } from "../domain/metrics/window";

const TAB = "x-performance";
const HEADER_RANGE = `${TAB}!A1:I1`;
const DATA_RANGE = `${TAB}!A2:I`;

interface Account { handle: string; name: string; type: "official" | "kol"; }

export interface RecordMetricsInput { month: string; officialHandle: string; roster: RosterEntry[]; }
export interface RecordMetricsResult { recorded: number; skipped: number; }

export class RecordMetrics {
  constructor(
    private readonly sheet: SheetClient,
    private readonly gateway: SourceGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: RecordMetricsInput): Promise<RecordMetricsResult> {
    const window = monthWindow(input.month);
    const accounts: Account[] = [
      { handle: input.officialHandle, name: "Mantle KR", type: "official" },
      ...input.roster.map((r) => ({ handle: r.handle, name: r.name, type: "kol" as const })),
    ];

    await this.sheet.ensureTab(TAB);
    const header = await this.sheet.getValues(HEADER_RANGE);
    if (header.length === 0 || (header[0] ?? []).length === 0) {
      await this.sheet.updateValues(HEADER_RANGE, [X_PERFORMANCE_HEADER]);
    }

    let recorded = 0;
    let skipped = 0;
    for (const acc of accounts) {
      try {
        const profile = await this.gateway.fetchUserProfile(acc.handle);
        const tweets: SourceTweet[] = [];
        for await (const t of this.gateway.fetchAuthoredTweets(acc.handle, window.startISO)) tweets.push(t);
        const agg = aggregateMonth(tweets, window);
        const row = [
          acc.handle,
          acc.name,
          acc.type,
          input.month,
          profile.followers !== undefined ? String(profile.followers) : "",
          String(agg.posts),
          String(agg.views),
          String(agg.engagement),
          this.now().toISOString(),
        ];
        await this.upsert(acc.handle, input.month, row);
        recorded += 1;
      } catch (err) {
        console.warn(`[metrics] ${acc.handle} skipped: ${(err as Error).message}`);
        skipped += 1;
      }
    }
    return { recorded, skipped };
  }

  private async upsert(handle: string, month: string, row: string[]): Promise<void> {
    const rows = await this.sheet.getValues(DATA_RANGE);
    const idx = rows.findIndex((r) => r[0] === handle && r[3] === month);
    if (idx >= 0) {
      const rowNumber = idx + 2; // data starts at sheet row 2
      await this.sheet.updateValues(`${TAB}!A${rowNumber}:I${rowNumber}`, [row]);
    } else {
      await this.sheet.appendValues(DATA_RANGE, [row]);
    }
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/app/recordMetrics.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/domain/sheet/models.ts src/app/RecordMetrics.ts tests/app/recordMetrics.test.ts
git commit -m "feat(metrics): RecordMetrics upserts monthly X performance per account"
```

---

### Task 8: `metrics:record` CLI

**Files:**
- Create: `src/cli/metrics-record.ts`
- Modify: `package.json` (add the `metrics:record` script)

**Interfaces:**
- Consumes: `skipIfLocal`, `argValue`, `loadConfig`/`loadGoogleAuthConfig`/`loadGoogleSheetConfig`, `createGoogleAuth`, `GoogleSheetClient`, `TwitterClient`, `TwitterApiSourceGateway`, `LoadRoster` (Task 6), `RecordMetrics` (Task 7), `currentMonth` (Task 3).

This is a thin composition CLI over units already unit-tested in Tasks 3/6/7. Following the repo
convention (CLIs like `collect.ts`/`sheet-init.ts` carry no unit test), it is verified by
`pnpm typecheck` + the full suite, not a new test file. Do NOT add a tautological smoke test.

- [ ] **Step 1: Implement**

Create `src/cli/metrics-record.ts`:

```ts
import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadConfig, loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LoadRoster } from "../app/LoadRoster";
import { RecordMetrics } from "../app/RecordMetrics";
import { currentMonth } from "../domain/metrics/window";

skipIfLocal("metrics:record");

const month = argValue("--month") ?? currentMonth(new Date());
const officialHandle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const roster = await new LoadRoster(sheet).run();
const result = await new RecordMetrics(sheet, gateway).run({ month, officialHandle, roster });

console.log(
  `metrics recorded for ${month}: ${result.recorded} account(s), ${result.skipped} skipped ` +
    `(official @${officialHandle} + ${roster.length} X KOL(s)).`,
);
```

Add to `package.json` scripts (near the other cloud CLIs, e.g. after `history:record` / `impressions:record`):

```json
    "metrics:record": "tsx --env-file-if-exists=.env src/cli/metrics-record.ts",
```

- [ ] **Step 2: Run typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean + full suite green (including `tests/config/envExample.test.ts`; `metrics-record.ts` reads `REFERENCE_X_HANDLE`, already documented in `.env.example` — if that test fails, add the missing var to `.env.example`).

- [ ] **Step 3: Commit**

```bash
git add src/cli/metrics-record.ts package.json
git commit -m "feat(metrics): metrics:record CLI wires the monthly X performance run"
```

---

### Task 9: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `docs/ko/capabilities.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`, add:

```markdown
- **`pnpm metrics:record [--month YYYY-MM]` — monthly X performance into the team workbook.** Reads
  the human `KOL list` tab (X rows only, matched by header name), then for the KR official account
  (`REFERENCE_X_HANDLE`, default `0xMantleKR`) and each X KOL fetches follower count + that month's
  authored tweets and writes `followers / posts / views / engagement` to a machine-owned
  `x-performance` tab, upserting one row per `(account, month)`. Raw numbers only — Avg/rates/
  Cost-per-Impression stay as spreadsheet formulas; the human roster/contract/monthly tabs and cost
  columns are never written. Telegram KOLs are left for manual entry (twitterapi.io is X-only). Cloud
  mode + the OAuth `spreadsheets` scope + `GSHEET_ID` required; `skipIfLocal`-gated. Not yet
  live-verified. See `docs/superpowers/specs/2026-07-27-x-performance-tracker-design.md`.
```

- [ ] **Step 2: Add a capabilities section**

In `docs/ko/capabilities.md`, add a section documenting `metrics:record`: the flow (KOL list 읽기 → X 계정 조회 → 월간 집계 → `x-performance` 탭에 upsert), what is automated (성과 숫자) vs manual (로스터·계약·Telegram KOL), that the writer never touches human tabs, and the cloud/scope/GSHEET_ID prerequisite. Match the file's existing heading style and Korean voice. Do not include any internal Lark link or real workbook data.

- [ ] **Step 3: Verify the docs reference the real command**

Run: `grep -nE 'metrics:record|x-performance' package.json CHANGELOG.md docs/ko/capabilities.md`
Expected: the script appears in `package.json` and is referenced in both docs.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ko/capabilities.md
git commit -m "docs(metrics): document the X performance tracker command"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (single machine-owned `x-performance` tab, `(account,month)` upsert, human tabs read-only) → Task 7 (upsert + column layout) + Task 2 (ensureTab).
- Decision 2 (raw metrics only; ratios/cost = formulas) → Task 7 writes only the 4 raw numbers + fetchedAt; no ratio/cost columns.
- Decision 3 (roster read by header name, defensive) → Task 6 (header mapping, skip non-X/section/blank) + Task 5 (handle extraction).
- Decision 4 (official = @0xMantleKR constant) → Task 7 (`officialHandle`, name "Mantle KR", type official) + Task 8 (`REFERENCE_X_HANDLE` default).
- Decision 5 (UserProfile.followers; SheetClient.ensureTab) → Task 1 + Task 2.
- Decision 6 (monthly aggregation: engagement=like+RT+reply+quote, views=ΣviewCount, posts=count; followers snapshot; month window) → Task 4 + Task 3 + Task 7.
- Non-goals (Telegram metrics, derived calc, roster/contract management, per-post/campaign, historical followers, writing existing monthly tabs) → nothing in any task does these.

**2. Placeholder scan:** No TBD/TODO; every code step has real code. Task 8 Step 1 is an intentionally-passing guard (documented) because the CLI is thin wiring over already-tested units; its correctness is enforced by `pnpm typecheck`. Task 9 Step 2 describes a doc section (matching an existing file's evolving Korean style) and Step 3 verifies the concrete command name landed.

**3. Type consistency:** `UserProfile.followers` (Task 1) is read in Task 7. `SheetClient.ensureTab` (Task 2) is called in Task 7 and stubbed in Task 6's fake. `MonthWindow`/`monthWindow`/`currentMonth` (Task 3) are used in Task 4/7/8. `aggregateMonth` → `MonthAggregate {posts,views,engagement}` (Task 4) consumed in Task 7. `extractXHandle(platform, link)` (Task 5) consumed in Task 6. `RosterEntry {name,handle}` (Task 6) consumed in Task 7's `RecordMetricsInput.roster`. `X_PERFORMANCE_HEADER` (Task 7) matches the 9-column `A1:I1` header and the `A2:I` / `A{n}:I{n}` ranges. `fetchUserProfile` on the port (Task 1) is called through `SourceGateway` in Task 7. Consistent.

**Deviation from spec noted:** the month upper bound is enforced client-side by `aggregateMonth` (fetch since `monthStart`, filter `< monthEndExclusive`) rather than an advanced_search `until_time`, to avoid changing the `SourceGateway.fetchAuthoredTweets` signature; for a past month this over-fetches up to the `MAX_PAGES` cap (noted in the spec's open items). Behaviour for the common current-month run is exact.
