# Impression Collection (§9b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the Google Sheet `history` tab, fetch each published X post's current view count, and write it into the reserved `impressions` / `impressionsAt` columns.

**Architecture:** One new use-case (`RecordImpressions`) composes two existing ports — `SheetClient` (read `history`, write H/I) and `SourceGateway.fetchByIds` (batch tweet lookup, already returns `metrics.viewCount`). No new port, adapter, or twitterapi.io endpoint. A thin `impressions:record` CLI wires them, gated by storage mode like the other Sheet commands.

**Tech Stack:** TypeScript (ESM, hexagonal: domain/ports/adapters/app/cli), `zod`-only runtime dep, native `fetch`, vitest.

**Spec:** `docs/superpowers/specs/2026-07-21-impressions-design.md`

## Global Constraints

- Runtime dependencies stay **`zod`-only**. Add no package. Use only what already exists.
- Code and comments in **English**. `docs/ko/**` stays **Korean**; `.env.example` and `CHANGELOG.md` stay English.
- **No new port, adapter, or endpoint.** Reuse `SheetClient` and `SourceGateway.fetchByIds` exactly as they are.
- **Writes touch `history` columns H and I only.** A–G belong to `RecordPublish`; §9b never writes them, symmetric to `RecordPublish` writing only A–G.
- **Impressions = `viewCount` only** for v1. Leave a comment where it is extracted noting the tweet already carries `likeCount`/`retweetCount`/… so an engagement extension is additive (add columns + capture).
- `main` is branch-protected (PR + `test` CI required). Work on `feat/impressions` (already created; the spec commit is on it). Integration is by PR.
- Verification commands: `pnpm test` and `pnpm typecheck` for every task.

### `history` tab column layout (0-based row indices from `getValues`)

```
index 0 A itemId · 1 B type · 2 C channel · 3 D postId · 4 E url · 5 F status · 6 G publishedAt · 7 H impressions · 8 I impressionsAt
```
The sheet row number for data index `i` is `i + 2` (header is sheet row 1).

---

### Task 1: `RecordImpressions` use-case

**Files:**
- Create: `src/app/RecordImpressions.ts`
- Test: `tests/app/recordImpressions.test.ts`

**Interfaces:**
- Consumes: `SheetClient` (`src/ports/SheetClient.ts`: `getValues(range): Promise<string[][]>`, `updateValues(range, rows): Promise<void>`), `SourceGateway` (`src/ports/SourceGateway.ts`: `fetchByIds(ids: string[]): Promise<SourceTweet[]>`), `SourceTweet` (`src/domain/models.ts`, has `id: string` and `metrics?: { viewCount?: number; ... }`).
- Produces:
  - `class RecordImpressions` constructed as `new RecordImpressions(sheet: SheetClient, source: Pick<SourceGateway, "fetchByIds">, now?: () => Date)`.
  - `run(opts?: { since?: string }): Promise<ImpressionsResult>`.
  - `interface ImpressionFailure { postId: string; error: string }`.
  - `interface ImpressionsResult { updated: number; skipped: number; failed: number; failures: ImpressionFailure[] }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/app/recordImpressions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RecordImpressions } from "../../src/app/RecordImpressions";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { SourceTweet } from "../../src/domain/models";

const NOW = () => new Date("2026-07-21T00:00:00.000Z");
const STAMP = "2026-07-21T00:00:00.000Z";

function tweet(id: string, viewCount?: number): SourceTweet {
  return {
    id,
    conversationId: id,
    text: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    url: `https://x.com/i/${id}`,
    authorUserName: "a",
    isReply: false,
    isQuote: false,
    metrics: viewCount === undefined ? undefined : { viewCount },
  };
}

/** A history data row: [itemId, type, channel, postId, url, status, publishedAt, impressions, impressionsAt]. */
function sheetHarness(existing: string[][]) {
  const updated: { range: string; rows: string[][] }[] = [];
  const sheet: SheetClient = {
    getValues: async () => existing,
    appendValues: async () => {},
    updateValues: async (range, rows) => {
      updated.push({ range, rows });
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, updated };
}

function source(tweets: SourceTweet[]) {
  const seen: string[][] = [];
  return {
    seen,
    gw: {
      fetchByIds: async (ids: string[]) => {
        seen.push(ids);
        return tweets;
      },
    },
  };
}

describe("RecordImpressions", () => {
  it("writes viewCount + timestamp to H/I of the matching X row, and nowhere else", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", 1234)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([["tw1"]]);
    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["1234", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("ignores non-X rows entirely (never fetches or writes them)", async () => {
    const h = sheetHarness([
      ["x:1", "announcement", "telegram", "tg1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "announcement", "kakao", "kk1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ]);
    const s = source([]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([]); // fetchByIds not called when nothing is eligible
    expect(h.updated).toEqual([]);
    expect(res).toEqual({ updated: 0, skipped: 0, failed: 0, failures: [] });
  });

  it("skips an X row whose postId is empty", async () => {
    const h = sheetHarness([["x:1", "x", "x", "", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([]);
    expect(res.updated).toBe(0);
  });

  it("with --since, processes only rows published on or after the cutoff", async () => {
    const h = sheetHarness([
      ["x:old", "x", "x", "twOld", "u", "posted", "2026-07-10T00:00:00.000Z", "", ""],
      ["x:new", "x", "x", "twNew", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ]);
    const s = source([tweet("twNew", 50)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run({ since: "2026-07-15" });

    expect(s.seen).toEqual([["twNew"]]); // twOld filtered out before fetch
    expect(h.updated).toEqual([{ range: "history!H3:I3", rows: [["50", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("skips a row whose tweet the gateway does not return, preserving its existing H/I", async () => {
    const h = sheetHarness([
      ["x:1", "x", "x", "twAlive", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "x", "x", "twGone", "u", "posted", "2026-07-20T00:00:00.000Z", "old", "oldAt"],
    ]);
    const s = source([tweet("twAlive", 9)]); // twGone omitted (deleted/protected)

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["9", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 1, failed: 0, failures: [] });
  });

  it("skips a tweet with no viewCount rather than writing 0", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", undefined)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(h.updated).toEqual([]);
    expect(res).toEqual({ updated: 0, skipped: 1, failed: 0, failures: [] });
  });

  it("isolates a per-row update failure and still writes the others", async () => {
    const existing = [
      ["x:1", "x", "x", "twA", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "x", "x", "twB", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ];
    const updated: { range: string; rows: string[][] }[] = [];
    const sheet: SheetClient = {
      getValues: async () => existing,
      appendValues: async () => {},
      updateValues: async (range, rows) => {
        if (range === "history!H2:I2") throw new Error("boom");
        updated.push({ range, rows });
      },
      createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    };
    const s = source([tweet("twA", 1), tweet("twB", 2)]);

    const res = await new RecordImpressions(sheet, s.gw, NOW).run();

    expect(updated).toEqual([{ range: "history!H3:I3", rows: [["2", STAMP]] }]);
    expect(res.updated).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual([{ postId: "twA", error: "boom" }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/app/recordImpressions.test.ts`
Expected: FAIL — cannot resolve `src/app/RecordImpressions`.

- [ ] **Step 3: Implement**

Create `src/app/RecordImpressions.ts`:

```ts
import type { SheetClient } from "../ports/SheetClient";
import type { SourceGateway } from "../ports/SourceGateway";

const DATA_RANGE = "history!A2:I"; // every history data row (header is row 1)

export interface ImpressionFailure {
  postId: string;
  error: string;
}

export interface ImpressionsResult {
  updated: number;
  skipped: number;
  failed: number;
  failures: ImpressionFailure[];
}

/**
 * Fills the reserved impression columns (H, I) of the `history` tab with each published X post's
 * current view count. Reads only what RecordPublish wrote (A–G) and writes only H/I, so the two
 * subsystems share a row while owning disjoint columns.
 */
export class RecordImpressions {
  constructor(
    private readonly sheet: SheetClient,
    private readonly source: Pick<SourceGateway, "fetchByIds">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(opts: { since?: string } = {}): Promise<ImpressionsResult> {
    const rows = await this.sheet.getValues(DATA_RANGE);

    // Capture each row's 1-based sheet row number (index + 2) before filtering, so writes target
    // the right row after the eligible subset is taken.
    const eligible = rows
      .map((row, index) => ({ row, rowNumber: index + 2 }))
      .filter(({ row }) => {
        const channel = row[2]; // col C
        const postId = row[3]; // col D
        const publishedAt = row[6] ?? ""; // col G
        if (channel !== "x" || !postId) return false;
        if (opts.since && publishedAt < opts.since) return false;
        return true;
      });

    if (eligible.length === 0) return { updated: 0, skipped: 0, failed: 0, failures: [] };

    const tweets = await this.source.fetchByIds(eligible.map((e) => e.row[3]));
    const viewCountById = new Map<string, number>();
    for (const t of tweets) {
      // Only viewCount is recorded (col H). fetchByIds already returns the whole tweet, so
      // t.metrics also carries likeCount/retweetCount/replyCount/quoteCount/bookmarkCount — if
      // engagement columns are ever added (J/K…), capture them here; the fetch is already paid for.
      const v = t.metrics?.viewCount;
      if (v !== undefined) viewCountById.set(t.id, v);
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failures: ImpressionFailure[] = [];
    const stamp = this.now().toISOString();

    for (const { row, rowNumber } of eligible) {
      const postId = row[3];
      const viewCount = viewCountById.get(postId);
      if (viewCount === undefined) {
        // Tweet not returned (deleted/protected) or without a view count — leave H/I as they are.
        skipped += 1;
        continue;
      }
      try {
        await this.sheet.updateValues(`history!H${rowNumber}:I${rowNumber}`, [[String(viewCount), stamp]]);
        updated += 1;
      } catch (err) {
        failed += 1;
        failures.push({ postId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return { updated, skipped, failed, failures };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 7 new tests, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/RecordImpressions.ts tests/app/recordImpressions.test.ts
git commit -m "feat(impressions): RecordImpressions fills history H/I from X view counts

Reuses SheetClient + SourceGateway.fetchByIds; writes only the reserved
impression columns, per-row graceful skip for deleted/metric-less tweets."
```

---

### Task 2: `impressions:record` CLI

**Files:**
- Create: `src/cli/impressions-record.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: `RecordImpressions` from Task 1. `skipIfLocal` (`src/cli/skipIfLocal.ts`), `argValue` (`src/cli/args.ts`), `createGoogleAuth` (`src/adapters/drive/createGoogleAuth.ts`), `GoogleSheetClient` (`src/adapters/sheets/GoogleSheetClient.ts`), `TwitterClient` + `TwitterApiSourceGateway` (`src/adapters/twitterapi/`), `loadConfig`/`loadGoogleAuthConfig`/`loadGoogleSheetConfig` (`src/config.ts`).
- Produces: `pnpm impressions:record [--since <YYYY-MM-DD>]`.

- [ ] **Step 1: Create the CLI**

Create `src/cli/impressions-record.ts`:

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { skipIfLocal } from "./skipIfLocal";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { RecordImpressions } from "../app/RecordImpressions";
import { loadConfig, loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";

skipIfLocal("impressions:record");
const since = argValue("--since");

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const { spreadsheetId } = loadGoogleSheetConfig();
const sheet = new GoogleSheetClient(auth, spreadsheetId);
const source = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const result = await new RecordImpressions(sheet, source).run({ since });
console.log(`impressions: ${result.updated} updated · ${result.skipped} skipped · ${result.failed} failed`);
for (const f of result.failures) console.error(`  ✗ ${f.postId}: ${f.error}`);
if (result.failed > 0) process.exitCode = 1;
```

- [ ] **Step 2: Add the package script**

In `package.json`, add this line to `"scripts"` immediately after the `"history:record"` line:

```json
    "impressions:record": "tsx --env-file-if-exists=.env src/cli/impressions-record.ts",
```

- [ ] **Step 3: Verify the local-mode skip (no network, no creds)**

Run: `HERALD_STORAGE_MODE=local pnpm impressions:record`
Expected: prints `impressions:record: local mode — skipped (set HERALD_STORAGE_MODE=cloud to enable)` and exits 0. (Confirms the CLI is gated like the other Sheet commands and does not require any credential in local mode.)

- [ ] **Step 4: Typecheck and full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/impressions-record.ts package.json
git commit -m "feat(cli): impressions:record wires RecordImpressions, gated in local mode"
```

---

### Task 3: Documentation + CHANGELOG

**Files:**
- Modify: `docs/ko/artifacts.md` (§3 command I/O table)
- Modify: `docs/architecture/external-integrations.md` (the Sheets row's `§9b` parenthetical)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1–2.
- Produces: nothing code-level.

- [ ] **Step 1: Add the command to `docs/ko/artifacts.md` §3**

In the `## 3. 명령어별 입출력` table, add a row immediately after the `pnpm history:record` row (Korean, matching the surrounding cells' tone):

```markdown
| `pnpm impressions:record [--since <YYYY-MM-DD>]` | `history` 탭 전체(`history!A2:I`); `channel=x`이고 `postId` 있는 행의 트윗을 `GET /twitter/tweets`로 조회(`--since`면 `publishedAt` ≥ 커트오프만). `TWITTERAPI_IO_KEY`(env) | 각 행의 **H(impressions=viewCount)·I(impressionsAt)** 만 갱신 — A–G는 안 건드림 | twitterapi.io(트윗 조회), Google Sheets(history 갱신) |
```

- [ ] **Step 2: Update the `§9b` mention in `docs/architecture/external-integrations.md`**

Find the Sheets row in the Google APIs table — it contains `(수신처 / 이력; 임프레션 = §9b)`. Change that parenthetical to reflect that §9b now exists for X:

```
(수신처 / 이력; 임프레션 ③ = `pnpm impressions:record`, X의 viewCount를 H/I에 기록 — 라이브 검증은 spreadsheets 스코프 필요)
```

Leave the rest of the row unchanged.

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added` (create the `### Added` subsection directly under `## [Unreleased]` if it does not exist yet — this release cut 0.2.0, so Unreleased may be empty), add:

```markdown
- **`pnpm impressions:record` (§9b ③).** Reads the Sheet `history` tab, fetches each published X
  post's current view count via the existing `SourceGateway.fetchByIds`
  (`GET /twitter/tweets?tweet_ids=`), and writes it to the reserved `impressions` / `impressionsAt`
  columns (H/I) — the columns `RecordPublish` deliberately leaves empty. `--since <YYYY-MM-DD>`
  narrows to rows published on or after a cutoff; deleted or metric-less tweets are skipped per row.
  X only for v1; not yet live-verified (needs the `spreadsheets` scope, like §9a).
```

- [ ] **Step 4: Verify no source file changed and the suite is green**

Run:

```bash
git status --short   # only docs/ko, docs/architecture, CHANGELOG.md
pnpm test            # unchanged: still green
```

Expected: only the three documentation files are modified; the suite still passes.

- [ ] **Step 5: Commit**

```bash
git add docs/ko/artifacts.md docs/architecture/external-integrations.md CHANGELOG.md
git commit -m "docs: document impressions:record (§9b)"
```

---

### Task 4: Open the PR

**Files:** none modified.

- [ ] **Step 1: Full verification**

Run: `pnpm test && pnpm typecheck`
Expected: both pass. Record the test count.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/impressions
gh pr create --title "feat: impression collection (§9b) — X view counts into the history tab" --body "$(cat <<'EOF'
Implements §9b (③ of the Sheet data hub): reads the `history` tab, fetches each published X post's
current view count, and writes it to the reserved `impressions` / `impressionsAt` columns (H/I).

- `RecordImpressions` composes the two existing ports — `SheetClient` and
  `SourceGateway.fetchByIds` (which already returns `metrics.viewCount`). No new port, adapter, or
  twitterapi.io endpoint.
- Writes touch H/I only; A–G belong to `RecordPublish`. The two subsystems share a row, disjoint
  columns.
- `--since <YYYY-MM-DD>` narrows to recent rows; deleted/metric-less tweets skip per row; per-row
  update failures are isolated.
- `impressions:record` is gated like the other Sheet commands (no-op, exit 0, in local mode).

X only for v1. Not yet live-verified — needs the `spreadsheets` OAuth scope, same status as §9a.

Spec: `docs/superpowers/specs/2026-07-21-impressions-design.md`
Plan: `docs/superpowers/plans/2026-07-21-impressions.md`
EOF
)"
```

- [ ] **Step 3: Wait for CI**

Run: `gh pr checks --watch`
Expected: the required `test` check passes.
