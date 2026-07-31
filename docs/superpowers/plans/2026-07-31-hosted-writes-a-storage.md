# Plan A — Storage: move the record of truth to Postgres

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The local CLI and `pnpm serve` run entirely on PostgreSQL, with a tested round trip back to `output/` files as the rollback path.

**Architecture:** Every `Json*Store` gains a `Pg*` sibling behind the same port. A thin `Db` interface lets one store implementation run against both `pg` (production) and PGlite (tests). Read-modify-write becomes `INSERT ... ON CONFLICT`, which retires `serialWrites.ts` and `fileLock.ts`. No Vercel work here — that is Plan C.

**Tech Stack:** TypeScript (ESM, `type: module`), `pg`, `@electric-sql/pglite` (dev), vitest, zod (already the only runtime dep).

**Spec:** `docs/superpowers/specs/2026-07-31-hosted-writes-design.md`

## Global Constraints

- Code, comments, commit messages and PR titles in **English**. Chat is Korean. User-facing CLI/dashboard strings stay Korean where they already are.
- **One source of truth.** No task may introduce a mode where a store reads files in one configuration and Postgres in another. There is no JSON/Postgres switch.
- `DATABASE_URL` is **required**; absent → the command refuses. `HERALD_DB_ENV` (`production` | `development`) is **stated, never inferred** from the URL. This mirrors `src/storage/mode.ts`, which is the reference for tone and structure.
- Tests use a **real Postgres** (PGlite), never a mock or a fake. This matches `tests/adapters/store/*`, which write real files to real temp directories.
- Each store keeps its port's exact signature. Ports are not redesigned in this plan.
- Every task ends green: `pnpm test` and `pnpm typecheck` both pass before the commit.
- Do **not** run `db:import` against the real `output/` tree. Building and testing the tool is in scope; migrating live data is a human-supervised step after this plan.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src/adapters/db/Db.ts` | The one query interface every `Pg*` store depends on. Decouples stores from `pg` vs PGlite |
| `src/adapters/db/schema.ts` | Ordered DDL statements + `applySchema(db)`. The single definition of every table |
| `src/adapters/db/createDb.ts` | Builds a `Db` from `DATABASE_URL` using a `pg` Pool |
| `src/ports/XArticleLedger.ts` | Extracted port — `JsonXArticleLedger` is currently a concrete class with no interface |
| `src/adapters/store/Pg*.ts` | Eleven store implementations, one per port |
| `src/cli/db-import.ts` | `output/` → database. Idempotent |
| `src/cli/db-export.ts` | Database → `output/` layout. The rollback path |
| `tests/support/testDb.ts` | A fresh PGlite instance with the schema applied, per test |

**Modified:**

| File | Change |
|---|---|
| `src/config.ts` | Add `loadDbConfig()` |
| `src/cli/serve.ts` | Construct `Pg*` stores instead of `Json*` |
| `src/cli/*.ts` (14 commands) | Same swap. Listed per task |
| `src/cli/doctor.ts`, `src/cli/status.ts` | Report the attached database |
| `src/cli/stateFiles.ts` | `state:push` reads the database, not files |

**Deleted:** `src/shared/store/serialWrites.ts`, `src/shared/store/fileLock.ts`, and their tests.

---

## Task 1: Database interface and test harness

**Files:**
- Create: `src/adapters/db/Db.ts`, `src/adapters/db/schema.ts`, `tests/support/testDb.ts`
- Test: `tests/adapters/db/schema.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `interface Db { query<R>(sql: string, params?: unknown[]): Promise<R[]>; tx<T>(fn: (db: Db) => Promise<T>): Promise<T> }`; `applySchema(db: Db): Promise<void>`; `createTestDb(): Promise<Db & { close(): Promise<void> }>`

- [ ] **Step 1: Add dependencies**

```bash
pnpm add pg
pnpm add -D @electric-sql/pglite @types/pg
```

- [ ] **Step 2: Write the failing test**

Create `tests/adapters/db/schema.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("applySchema", () => {
  it("creates every table the stores need", async () => {
    db = await createTestDb();
    const rows = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "deliveries", "few_shot_examples", "lark_items", "lineage", "outlet_overrides",
      "publish_entries", "renderings", "translations", "variants", "x_article_deliveries", "x_threads",
    ]);
  });

  it("is idempotent — applying twice does not throw", async () => {
    db = await createTestDb();
    const { applySchema } = await import("../../../src/adapters/db/schema");
    await expect(applySchema(db)).resolves.not.toThrow();
  });

  it("rejects a second delivery row for the same (item, type, outlet)", async () => {
    db = await createTestDb();
    const insert = `insert into deliveries (item_id, type, outlet_id, status, at, by)
                    values ($1, $2, $3, 'sent', '2026-07-29T00:00:00.000Z', 'auto')`;
    await db.query(insert, ["x:1", "announcement", "tg-community"]);
    await expect(db.query(insert, ["x:1", "announcement", "tg-community"])).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm vitest run tests/adapters/db/schema.test.ts`
Expected: FAIL — cannot resolve `../../support/testDb`.

- [ ] **Step 4: Implement `Db`, `schema`, and `createTestDb`**

Invariants, not code — write these yourself against the shapes below.

`Db.ts` exposes exactly `query` and `tx`. `query` returns rows as plain objects. `tx` runs `fn` inside `BEGIN`/`COMMIT`, rolling back on throw, and passes a `Db` bound to that connection so nested calls join the same transaction. Nothing else belongs in this file — it exists so stores never import `pg` or PGlite directly.

`schema.ts` exports `applySchema(db)`, which runs an ordered list of `create table if not exists` statements. Column names are `snake_case`; the stores map to camelCase. Every table's natural key is a primary key or unique constraint, taken from the port's own key comment:

| Table | Key | From |
|---|---|---|
| `x_threads` | `root_id` | `CollectionRepository.upsert` merges by rootId |
| `lark_items` | `id` | |
| `translations` | `item_id` | `TranslationStore.upsert` — "by itemId" |
| `variants` | `(item_id, type)` | `ConversionStore` — `listConvertedKeys` |
| `renderings` | `(item_id, type, channel)` | `FormattingStore` — `listRenderedKeys` |
| `outlet_overrides` | `(item_id, type, outlet_id)` | |
| `deliveries` | `(item_id, type, outlet_id)` | **`deliveryKey()` in `domain/delivery/models.ts:38`** |
| `x_article_deliveries` | whatever `JsonXArticleLedger.loadKeys()` keys on — read it |
| `publish_entries` | `(item_id, status, target)` | `PublishStore.listEntries` doc comment |
| `few_shot_examples` | `(scope, item_id)` where scope is `translation` or `conversion:<type>` | Distinguishes `translation/few-shot.json` from `conversion/few-shot.<type>.json` |
| `lineage` | none — append-only, surrogate id | `LineageStore.append` |

Read the corresponding domain model in `src/domain/` for each table's columns. Optional TypeScript fields are nullable columns. Timestamps are stored as `text` holding the ISO string the models already carry — do **not** convert to `timestamptz`, because `db:export` must reproduce the original bytes (Task 16) and a round trip through a timestamp type will not.

`tests/support/testDb.ts` exports `createTestDb()`, which starts an in-memory PGlite, wraps it in the `Db` interface, applies the schema, and returns it with a `close()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/adapters/db/schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add package.json pnpm-lock.yaml src/adapters/db tests/adapters/db tests/support/testDb.ts
git commit -m "feat(db): schema, query interface and a PGlite test harness"
```

---

## Task 2: Database configuration that refuses to guess

**Files:**
- Modify: `src/config.ts`
- Create: `src/adapters/db/createDb.ts`
- Test: `tests/config.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `Db` from Task 1
- Produces: `loadDbConfig(): { url: string; env: "production" | "development" }`; `createDb(cfg): Db & { close(): Promise<void> }`

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```typescript
describe("loadDbConfig", () => {
  const clear = () => { delete process.env.DATABASE_URL; delete process.env.HERALD_DB_ENV; };
  beforeEach(clear);
  afterEach(clear);

  it("refuses when DATABASE_URL is absent", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.HERALD_DB_ENV = "development";
    expect(() => loadDbConfig()).toThrow(/DATABASE_URL/);
  });

  it("refuses when HERALD_DB_ENV is absent — it is never inferred from the URL", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    expect(() => loadDbConfig()).toThrow(/HERALD_DB_ENV/);
  });

  it("refuses an HERALD_DB_ENV that is neither production nor development", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    process.env.HERALD_DB_ENV = "staging";
    expect(() => loadDbConfig()).toThrow(/production/);
  });

  it("returns both when both are stated", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    process.env.HERALD_DB_ENV = "production";
    expect(loadDbConfig()).toEqual({ url: "postgres://localhost/herald", env: "production" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/config.test.ts -t loadDbConfig`
Expected: FAIL — `loadDbConfig` is not exported.

- [ ] **Step 3: Implement**

Add `loadDbConfig()` to `src/config.ts` following the shape of the loaders already there. The refusal messages must name the missing variable and say what to do, the way `src/storage/mode.ts` does with its `REMEDY` constant — read that file first and match its register. A production URL must never be reachable by accident, so nothing may default.

`createDb.ts` builds a `pg` Pool and adapts it to `Db`. Keep it to construction; no store logic.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run tests/config.test.ts -t loadDbConfig
pnpm typecheck
git add src/config.ts src/adapters/db/createDb.ts tests/config.test.ts
git commit -m "feat(db): require DATABASE_URL and an explicit HERALD_DB_ENV"
```

---

## Task 3: PgTranslationStore

This task is the **template for Tasks 4–13**. Read it before starting any of them.

**Files:**
- Create: `src/adapters/store/PgTranslationStore.ts`
- Test: `tests/adapters/store/PgTranslationStore.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1), `createTestDb` (Task 1)
- Produces: `class PgTranslationStore implements TranslationStore { constructor(db: Db) }`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgTranslationStore } from "../../../src/adapters/store/PgTranslationStore";
import type { Translation } from "../../../src/domain/translation/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function translation(itemId: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId, source: "x", sourceText: "s", koreanText: "ko",
    status: "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("PgTranslationStore", () => {
  it("round-trips a translation", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    expect(await store.loadAll()).toEqual([translation("x:1")]);
  });

  it("upserts by itemId rather than appending", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    await store.upsert(translation("x:1", { koreanText: "고침", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.koreanText).toBe("고침");
    expect(all[0]?.status).toBe("approved");
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("approvedAt", null);
    expect(row?.approvedAt).toBeUndefined();
  });

  it("listTranslatedIds returns every stored itemId", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await store.upsert(translation("x:1"));
    await store.upsert(translation("lark:2", { source: "lark" }));
    expect([...(await store.listTranslatedIds())].sort()).toEqual(["lark:2", "x:1"]);
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgTranslationStore(db);
    await Promise.all([store.upsert(translation("x:1")), store.upsert(translation("x:2"))]);
    expect(await store.listTranslatedIds()).toEqual(new Set(["x:1", "x:2"]));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/adapters/store/PgTranslationStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Invariants:

- Implements `TranslationStore` (`src/ports/TranslationStore.ts`) exactly — no extra public methods.
- `upsert` is **one statement**: `insert ... on conflict (item_id) do update set ...`. If you find yourself calling `loadAll()` inside `upsert`, stop: that is the read-modify-write this migration exists to delete.
- `loadAll()` returns rows in **insertion order**, not key order. Every table carries a monotonic `ordinal` column set on first insert and left alone by an update; `loadAll()` is `order by ordinal`. Key order would be deterministic but wrong: `JsonTranslationStore` appends, so the file's order is insertion order, and Task 16 asserts the export reproduces the original file byte for byte. Ordering by `item_id` passes every test in this task and fails that one.
- Mapping `null` → absent is the store's job. The third test above exists because `JSON.stringify` of a `null` differs from an omitted key, and `db:export` (Task 16) must reproduce the original file.
- Read `src/adapters/store/JsonTranslationStore.ts` first for the behaviour being replaced.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/adapters/store/PgTranslationStore.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add src/adapters/store/PgTranslationStore.ts tests/adapters/store/PgTranslationStore.test.ts
git commit -m "feat(store): PgTranslationStore"
```

---

## Tasks 4–13: the remaining ten stores

Each follows Task 3's five steps exactly: failing test → confirm red → implement against invariants → green → commit. Per store, the test file mirrors the existing `Json*` test where one exists — **open it and port its cases**, because those cases encode bugs already found once.

For every store: implement the port unchanged, make `upsert`/`add` a single `on conflict` statement, order reads deterministically, and map `null` to absent.

### Task 4: PgConversionStore
Port `src/ports/ConversionStore.ts`. Existing test: `tests/adapters/store/JsonConversionStore.test.ts`. Key `(item_id, type)`. `listConvertedKeys()` returns `` `${itemId}:${type}` ``.

### Task 5: PgFormattingStore
Port `src/ports/FormattingStore.ts`. Existing test: `tests/adapters/store/JsonFormattingStore.test.ts`. Key `(item_id, type, channel)`. Note `refined` is a boolean column, and `status` distinguishes `rendered` from `approved` — the 2차 approval this whole project is about.

### Task 6: PgOutletOverrideStore
Port `src/ports/OutletOverrideStore.ts`. Key `(item_id, type, outlet_id)`. `remove(key)` takes the joined string key — read `src/adapters/store/JsonOutletOverrideStore.ts` for how it is split, and keep that parsing identical.

### Task 7: PgDeliveryLedger — the important one
Port `src/ports/DeliveryLedger.ts`. Existing test: `tests/adapters/store/JsonDeliveryLedger.test.ts` — **port every case**, including the concurrency one.

Additional required test, replacing what `fileLock` used to guarantee:

```typescript
it("refuses a duplicate (item, type, outlet) at the database, not in application code", async () => {
  db = await createTestDb();
  const ledger = new PgDeliveryLedger(db);
  const entry = { itemId: "x:1", type: "announcement", outletId: "tg-community",
                  status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };
  await ledger.add(entry);
  await ledger.add({ ...entry, url: "https://t.me/c/1/2" });
  const all = await ledger.loadAll();
  expect(all).toHaveLength(1);
  expect(all[0]?.url).toBe("https://t.me/c/1/2");
});

it("keeps two rooms on one channel apart — THE bug the re-keying exists to prevent", async () => {
  db = await createTestDb();
  const ledger = new PgDeliveryLedger(db);
  await ledger.add({ itemId: "x:1", type: "announcement", outletId: "tg-community",
                     status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" });
  const keys = await ledger.loadKeys();
  expect(keys.has("x:1:announcement:tg-community")).toBe(true);
  expect(keys.has("x:1:announcement:tg-dev")).toBe(false);
});
```

`loadAll()` must still fall back to legacy rows the way `JsonDeliveryLedger` falls back to `channels.json` — read its doc comment (lines 20–30) and preserve the behaviour it describes. `db:import` (Task 15) imports legacy rows into the same table, so the fallback becomes a no-op at rest; the *semantics* it protects must survive.

### Task 8: PgXArticleLedger — extract a port first
`JsonXArticleLedger` has **no port**; it is a concrete class. Before implementing, create `src/ports/XArticleLedger.ts` from its public surface (`loadKeys`, `add`, plus whatever `ReconcilePublished` and `publishHeadroom.ts` call — grep for `xArticleLedger` and `articleLedger`), and make `JsonXArticleLedger` declare `implements XArticleLedger`. Commit that extraction separately, then implement `PgXArticleLedger`. Existing test: `tests/adapters/store/JsonXArticleLedger.test.ts`.

### Task 9: PgPublishStore
Port `src/ports/PublishStore.ts`. Existing test: `tests/adapters/store/jsonPublishStore.test.ts`. Key `(item_id, status, target)` per the port's own comment.

### Task 10: PgFewShotStore
Port `src/ports/FewShotStore.ts`. Existing tests: `tests/adapters/store/translationStores.test.ts` and `tests/adapters/jsonFewShotStore.tm.test.ts`.

One class covers both flavours via a `scope` constructor argument: `"translation"` for `translation/few-shot.json`, `"conversion:<type>"` for each `conversion/few-shot.<type>.json`. Provide a `fewShotStoresByType(db)` helper matching the existing `fewShotStoresByType` in `JsonTypedFewShotStore.ts` so `serve.ts` and `ApproveRendering` wire up unchanged.

`add` upserts by `item_id` **when present** and appends otherwise — an example with no `itemId` must never collide with another. Use a generated key for those rows rather than a null in the unique tuple.

### Task 11: PgLineageStore
Port `src/ports/LineageStore.ts`. Existing test: `tests/adapters/jsonlLineageStore.test.ts`. Append-only, surrogate primary key, no uniqueness. `listItems()` returns one `LineageSummary` per item — a `group by item_id` with a count and the last stage by `at`.

### Task 12: PgCollectionRepository
Port `src/ports/CollectionRepository.ts`. Existing test: `tests/adapters/localJsonStore.test.ts`.

This is the subtlest one. `LocalJsonStore.upsert` merges threads and tweets with rules that exist because of real data loss — read `mergeTweet`'s doc comment about an article's `blocks` regressing to a bare t.co link, and **port that rule and its test**. The merge stays in TypeScript rather than becoming SQL, because it is domain logic and is already tested.

`tweets` is a **`json` column, not `jsonb`** — Task 1 changed it after review. `jsonb` parses to a binary form that normalizes key order and whitespace, so it cannot reproduce the original bytes, and Task 16 asserts exactly that. Do not change the column type.

Two hazards specific to this store:

- `upsert(threads)` takes an **array**. "One statement per write" here means one per thread, not a read-modify-write of the table. `loadAll()` inside `upsert` is the anti-pattern; a targeted read of only the rows being merged is what the merge needs and is fine. Wrap the batch in `Db.tx` so a partial merge cannot be observed.
- **Always `JSON.stringify` the tweets array before passing it as a parameter.** `pg` serializes a raw JS array as a Postgres *array literal*, while PGlite does not — so relying on the driver passes every test here and breaks under `pg`. For a non-empty array Postgres rejects the malformed JSON outright, which is loud; the **empty** array is the dangerous case, storing `{}` and only failing later when `json_array_elements` or iteration meets it. This divergence was found empirically during implementation; it is the one place in this plan where PGlite and `pg` genuinely disagree.

`LocalJsonStore` also implements `WatermarkStore` (`get`/`set` over `x/state.json`). Watermarks stay on disk — `collect` is a local job per the spec — so `PgCollectionRepository` implements `CollectionRepository` **only**. Leave `LocalJsonStore` in place for the watermark half and note it in the commit body.

### Task 13: PgContentSource
Port `src/ports/ContentSource.ts`. Reads `x_threads` and `lark_items` and flattens to `ContentItem[]`, filtering out ids in the passed set.

The flattening logic already exists in `src/adapters/content/XContentSource.ts` and `LarkContentSource.ts` — including media markers and article rendering. **Extract the pure flattening functions from those files and reuse them**; do not reimplement. `tests/adapters/content/` covers that behaviour and must keep passing untouched.

---

## Task 14: Delete the file-locking layer

**Files:**
- Delete: `src/shared/store/serialWrites.ts`, `src/shared/store/fileLock.ts`, and their tests
- Modify: `src/adapters/store/JsonDeliveryLedger.ts`, `src/adapters/store/JsonXArticleLedger.ts`, `src/storage/retention.ts`

- [ ] **Step 1: Confirm nothing but the Json ledgers still imports them**

Run: `grep -rn "serialWrites\|fileLock\|withFileLock" src tests`
Expected: hits only in the two Json ledgers, `src/storage/retention.ts`, and the files being deleted.

- [ ] **Step 2: Remove the wrapping**

The `Json*` ledgers stay in the tree — `db:export` (Task 16) writes through them, and their tests are the specification `db:export` must satisfy. Strip only the lock/serializer wrapping; keep their read-modify-write, which is correct for a single-process export.

`src/storage/retention.ts` also calls `withFileLock`. Read it: if it guards a file that still exists after this plan, give it a plain implementation rather than deleting its protection.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: PASS. Tests for the deleted modules are gone; every other test unchanged.

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm typecheck
git add -u src/shared/store src/adapters/store src/storage tests
git commit -m "refactor(store): retire the file lock — the unique index replaces it"
```

---

> ### ⚠ MERGE GATE — Tasks 14 to 17 must land together
>
> Task 14 deletes the in-process serializer and the file lock. Task 17 is what points `serve.ts` at
> the Postgres stores whose unique constraints replace them. **Between those two tasks the branch is
> in a state that must never be merged or deployed**: `serve.ts` still builds `JsonDeliveryLedger`
> and `JsonXArticleLedger`, so `ReconcilePublished` (every two minutes) and every dashboard or CLI
> send do read-modify-write on the same files with neither guard.
>
> That is precisely the lost-row → duplicate-live-post failure `serialWrites.ts` was written to
> describe. The two ledger tests were deliberately relaxed at Task 14 (from "both rows survive" to
> "at least one survives") to accept it, which is correct for an intermediate state and wrong for a
> shipped one.
>
> Harmless if the branch merges as a unit after Task 17. Do not merge, deploy, or cherry-pick
> Tasks 14–16 on their own.

## Task 14b: Make resend one transaction

> **Scope correction, recorded after implementation.** This task's premise — that `sendToOutlet.ts`
> "calls `remove(key)` then `add(...)`" — was only half right, and the half that matters is the
> other one. The three `restore` sites this task touches were already a single bare `add(restore)`,
> so replacing them with an atomic operation changes no behaviour. The `remove(key)` that genuinely
> opens a window is separated from its `add` by the **actual network send**, and it cannot be closed
> here: `SendChannels.run()` decides "already delivered" from its own ledger read via
> `deliveredToRoom`, so the room must really leave that predicate for a resend to proceed at all.
> No row both unblocks the send and reads as delivered — those are structurally opposite.
>
> Verified as **not a regression**: before this plan, `JsonDeliveryLedger.add` and `.remove` each
> took and released their *own* lock and `loadAll()` took none, so a concurrent reader saw the same
> gap. It is a pre-existing property of how resend is defined, not something the migration
> introduced.
>
> Closing it properly means changing how `SendChannels` decides "already delivered" — a resend-
> semantics question, not a storage one. **Out of scope for this plan**, and it needs its own design
> rather than being smuggled into a migration. `replace()` still earns its place as a correct
> primitive with the ordinal guarantee attached; it is just not the window-closer this task claimed.

**Files:**
- Modify: `src/cli/sendToOutlet.ts`
- Test: `tests/cli/sendToOutlet.test.ts` (append)

**Why:** `sendToOutlet.ts` calls `deliveryLedger.remove(key)` and later `add(...)`. Between them the ledger holds no row for a room that was sent to. The file lock hid that window; Task 14 deleted the lock. A concurrent read in that window sees a sent room as never-sent, which is the input to a second send.

- [ ] **Step 1: Write the failing test**

```typescript
it("never exposes a ledger with no row for a room mid-resend", async () => {
  const db = await createTestDb();
  const ledger = new PgDeliveryLedger(db);
  const entry = { itemId: "x:1", type: "announcement", outletId: "tg-community",
                  status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };
  await ledger.add(entry);

  // Observe the ledger from outside while a resend is in flight. Every observation must see
  // the room as delivered — before, during and after.
  const observations: boolean[] = [];
  const observing = (async () => {
    for (let i = 0; i < 20; i++) {
      observations.push((await ledger.loadKeys()).has("x:1:announcement:tg-community"));
      await new Promise((r) => setImmediate(r));
    }
  })();

  await replaceDeliveryRow(ledger, entry, { ...entry, url: "https://t.me/c/1/9" });
  await observing;

  expect(observations.every(Boolean)).toBe(true);
  await db.close();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/cli/sendToOutlet.test.ts -t mid-resend`
Expected: FAIL — at least one observation sees the row missing.

- [ ] **Step 3: Implement**

Add a single ledger operation that replaces a row atomically, and have the resend path call it instead of `remove` then `add`. Put it on the `DeliveryLedger` port so both ledgers offer it and `sendToOutlet.ts` does not reach around the interface.

Read `sendToOutlet.ts` lines 391–480 first. The `restore` variable there re-adds the previous row on three separate failure paths; each is a place the ledger must end up consistent, and folding remove+add into one operation simplifies all three rather than complicating them.

- [ ] **Step 4: Green, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add src/cli/sendToOutlet.ts src/ports/DeliveryLedger.ts src/adapters/store tests/cli/sendToOutlet.test.ts
git commit -m "fix(send): replace a delivery row atomically rather than remove-then-add"
```

---

## Task 15: `pnpm db:import`

**Files:**
- Create: `src/cli/db-import.ts`
- Test: `tests/cli/dbImport.test.ts`
- Modify: `package.json` (script `"db:import": "tsx --env-file-if-exists=.env src/cli/db-import.ts"`)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { importOutputTree } from "../../src/cli/db-import";
import { PgTranslationStore } from "../../src/adapters/store/PgTranslationStore";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "import-"));
  await mkdir(join(root, "translations"), { recursive: true });
  await writeFile(join(root, "translations", "translations.json"), JSON.stringify([
    { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "approved", translatedAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
  ], null, 2) + "\n", "utf8");
  return root;
}

describe("importOutputTree", () => {
  it("loads a translation from the output tree into the database", async () => {
    db = await createTestDb();
    await importOutputTree(db, await tree());
    const all = await new PgTranslationStore(db).loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.approvedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("is idempotent — importing the same tree twice leaves one row", async () => {
    db = await createTestDb();
    const root = await tree();
    await importOutputTree(db, root);
    await importOutputTree(db, root);
    expect(await new PgTranslationStore(db).loadAll()).toHaveLength(1);
  });

  it("treats an absent file as empty rather than failing", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "import-empty-"));
    await expect(importOutputTree(db, root)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/cli/dbImport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`db-import.ts` exports `importOutputTree(db: Db, outputRoot: string): Promise<ImportReport>` and has a thin entry script around it, matching how other `src/cli/*.ts` separate a runnable from a testable function.

Invariants:

- Reads each source file through its **existing `Json*` store**, pointed at `outputRoot`, and writes through the matching `Pg*` store. Do not re-parse JSON by hand: the Json stores already encode fallbacks (missing file → empty, legacy `channels.json`) that this must inherit.
- Idempotent because every write is an upsert on the natural key. Lineage is the exception — it is append-only, so import must not duplicate rows on a second run. Key lineage import on the full row content.
- Absent file → import zero rows for that store, never throw. A tree that predates a feature is normal.
- Returns per-store counts. The entry script prints them in pipeline order (translate → convert → format → send), the order `state:pull` already uses (`stateFiles.ts` `describeStateDiff`).
- Refuses to run when `HERALD_DB_ENV=production` unless `--yes` is passed, and prints which database it is about to write to first. Model the prompt on `state:pull`'s preview — an operator must see what they are about to change before they change it.
- **The legacy ledger is exclusive-or, not a union.** `JsonDeliveryLedger.loadAll()` returns `channels.json` only when `deliveries.json` is **absent** — when both exist the legacy file is ignored entirely. Importing both would resurrect rows a `remove()` deleted (undoing an untick of 전달함) and could overwrite a current `dropped` row back to `sent`. Reading through `JsonDeliveryLedger.loadAll()` rather than parsing the files yourself inherits this for free, which is the main reason that invariant is stated above.
- **Import is not idempotent against a stale tree.** Re-running it against an unchanged tree is safe (upsert on the natural key). Re-running it after cutover, against an `output/` tree that has since gone stale, is not: import never deletes, so it resurrects post-cutover removals and clobbers post-cutover edits with file values. Say this in the command's own refusal text, not only here.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run tests/cli/dbImport.test.ts && pnpm typecheck
git add src/cli/db-import.ts tests/cli/dbImport.test.ts package.json
git commit -m "feat(cli): pnpm db:import — output tree into the database"
```

---

## Task 16: `pnpm db:export` and the round trip

**Files:**
- Create: `src/cli/db-export.ts`
- Test: `tests/cli/dbRoundTrip.test.ts`
- Modify: `package.json` (script `"db:export"`)

**This task is the rollback path. It must exist and be green before any real data moves.**

- [ ] **Step 1: Write the failing round-trip test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { importOutputTree } from "../../src/cli/db-import";
import { exportOutputTree } from "../../src/cli/db-export";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const translations = [
  { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
    status: "approved", translatedAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
  { itemId: "lark:2", source: "lark", sourceText: "t", koreanText: "코", status: "translated",
    translatedAt: "2026-01-03T00:00:00.000Z" },
];

describe("import → export round trip", () => {
  it("reproduces the original file byte for byte", async () => {
    db = await createTestDb();
    const from = await mkdtemp(join(tmpdir(), "rt-from-"));
    await mkdir(join(from, "translations"), { recursive: true });
    const original = JSON.stringify(translations, null, 2) + "\n";
    await writeFile(join(from, "translations", "translations.json"), original, "utf8");

    await importOutputTree(db, from);
    const to = await mkdtemp(join(tmpdir(), "rt-to-"));
    await exportOutputTree(db, to);

    expect(await readFile(join(to, "translations", "translations.json"), "utf8")).toBe(original);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/cli/dbRoundTrip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`exportOutputTree(db: Db, outputRoot: string): Promise<ExportReport>` reads through each `Pg*` store and writes through the matching `Json*` store pointed at `outputRoot`.

The byte-for-byte assertion is deliberate and will catch three things — fix them in the store, not the test:

1. **Key order.** `JSON.stringify` emits insertion order. Construct objects with fields in the domain model's declaration order.
2. **Absent vs null.** An optional field the original omitted must stay omitted. This is what Task 3's third test guards.
3. **Row order.** The export must preserve the original array order. This is what the `ordinal` column from Task 3 is for — every store orders by it, so import order survives into the export. If a store was written ordering by its key instead, this test is where that shows up.

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
pnpm vitest run tests/cli/dbRoundTrip.test.ts && pnpm test && pnpm typecheck
git add src/cli/db-export.ts tests/cli/dbRoundTrip.test.ts package.json
git commit -m "feat(cli): pnpm db:export — the rollback path, verified by a round trip"
```

---

## Task 17: Rewire the CLI entry points

**Files modified** (each constructs `Pg*` instead of `Json*`):

`serve.ts`, `translate-prepare.ts`, `translate-save.ts`, `translate-align.ts`, `convert-prepare.ts`, `convert-save.ts`, `format.ts`, `format-save.ts`, `publish.ts`, `send-channels.ts`, `send-x-article.ts`, `send-reconcile.ts`, `kol-telegram-record.ts`, `status.ts`, `lineage.ts`, `sendToOutlet.ts`, `publishHeadroom.ts`, `lineage-wiring.ts`, `collect.ts`, `reconcile.ts`

- [ ] **Step 1: Confirm the full inventory before touching anything**

Run: `grep -rln "JsonTranslationStore\|JsonConversionStore\|JsonFormattingStore\|JsonOutletOverrideStore\|JsonDeliveryLedger\|JsonPublishStore\|JsonXArticleLedger\|JsonFewShotStore\|JsonTypedFewShotStore\|JsonlLineageStore\|LocalJsonStore\|XContentSource\|LarkContentSource" src/cli`

Reconcile the output against the list above. If a file appears that is not listed, add it — the list was written from a grep at plan time and the tree may have moved.

- [ ] **Step 2: Extract one shared construction site**

Every command currently news up its own stores against `paths.*`. Create `src/cli/stores.ts` exporting `createStores(db: Db)` returning the full set. This is what Plan C's `createDeps(env)` will build on, and doing it here means twenty files change once rather than twice.

`db-export.ts` keeps constructing `Json*` directly — it is the one place that must still write files.

- [ ] **Step 3: Rewire, one command per commit**

Work through the inventory. For each: swap construction, run that command's tests, commit. Do not batch — a single commit touching twenty entry points cannot be reviewed or bisected.

Commands that take no `--env-file` today now need database config; add `--env-file-if-exists=.env` to any `package.json` script that lacks it.

- [ ] **Step 4: Refuse to serve an empty ledger as "nothing was ever sent"**

This is the one new safety requirement in this task, and it exists because moving the ledger into Postgres silently changed a guarantee.

`JsonDeliveryLedger` protected the send history automatically, on every read: if `deliveries.json` was missing it fell back to `channels.json`, so an install could not accidentally present itself as having sent nothing. The database has no such fallback — `loadKeys()` on an empty table returns the empty set, and it looks exactly like a genuinely fresh install.

If the cutover happens without `db:import` having run, `SendChannels.run()`'s `already` and `planRooms()`'s `everDelivered` both read "never sent" for the entire backlog, and the next send re-posts all of it to live Telegram rooms and the brand's X account. Every guard in the send path is downstream of this read, so none of them catch it.

Add a startup guard on the send path: when the deliveries table is **empty** but the tree still has an `output/publish/deliveries.json` or `channels.json` with rows in it, refuse and say that `db:import` has not been run. An empty table with no legacy file present is a legitimately fresh install and proceeds silently.

- [ ] **Step 5: Test the guard**

```typescript
it("refuses to send when the ledger is empty but a populated legacy file is still on disk", async () => {
  db = await createTestDb();
  const root = await mkdtemp(join(tmpdir(), "cutover-"));
  await mkdir(join(root, "publish"), { recursive: true });
  await writeFile(join(root, "publish", "deliveries.json"), JSON.stringify([
    { itemId: "x:1", type: "announcement", outletId: "tg-community",
      status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" },
  ]), "utf8");
  await expect(assertLedgerMigrated(db, root)).rejects.toThrow(/db:import/);
});

it("stays silent for a genuinely fresh install — empty table, no legacy file", async () => {
  db = await createTestDb();
  const root = await mkdtemp(join(tmpdir(), "fresh-"));
  await expect(assertLedgerMigrated(db, root)).resolves.not.toThrow();
});
```

- [ ] **Step 6: Full suite green**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

---

## Task 18: `doctor` and `status` report the attached database

**Files:** `src/cli/doctor.ts`, `src/cli/status.ts`, `src/adapters/web/apiHandlers.ts` (`StatusView`)

- [ ] **Step 1: Write the failing test**

Add to `tests/doctor/`, matching the existing check tests there:

```typescript
it("reports the attached database and its stated environment", async () => {
  const result = await runDbCheck({ url: "postgres://localhost/herald", env: "development" }, async () => true);
  expect(result.ok).toBe(true);
  expect(result.detail).toContain("development");
});

it("fails the check when the database is unreachable", async () => {
  const result = await runDbCheck({ url: "postgres://localhost/herald", env: "production" }, async () => {
    throw new Error("ECONNREFUSED");
  });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2–4: Red, implement, green**

`doctor` gains a connectivity check. `status` prints the environment on its first line. `StatusView` gains a `dbEnv` field so the dashboard can show a banner when it is not production — the banner itself is Plan C's, but the field is needed here so both plans do not edit the same interface.

Never print the password. Show host and database name only.

- [ ] **Step 5: Commit**

```bash
pnpm test && pnpm typecheck
git add src/cli/doctor.ts src/cli/status.ts src/adapters/web/apiHandlers.ts tests/doctor
git commit -m "feat(doctor): report the attached database and its stated environment"
```

---

## Task 19: `state:push` snapshots the database

**Files:** `src/cli/stateFiles.ts`, `src/cli/state-push.ts`, `src/cli/state-pull.ts`

- [ ] **Step 1: Read `stateFiles.ts` in full before changing anything**

Its doc comment is the specification for what a snapshot holds and why each file is in or out. That judgement stays correct; only the source changes from disk to database.

- [ ] **Step 2: Write the failing test**

```typescript
it("snapshots the database through the same seven-file bundle", async () => {
  db = await createTestDb();
  await new PgTranslationStore(db).upsert({
    itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
    status: "approved", translatedAt: "2026-01-01T00:00:00.000Z",
  });
  const files = await snapshotFromDb(db);
  const translations = files.find((f) => f.rel === "output/translations/translations.json");
  expect(translations).toBeDefined();
  expect(JSON.parse(translations!.body)).toHaveLength(1);
});
```

- [ ] **Step 3: Implement**

`state:push` builds its bundle by exporting from the database into memory — the same code path as `db:export`, writing to a buffer instead of a tree. `state:pull` restores by importing into the database, keeping its existing preview-then-confirm behaviour and its `유지`/`복원`/`덮어씀` row descriptions verbatim.

`renderings.json` now joins the bundle. `stateFiles.ts`'s comment explains its exclusion on the grounds that `format` regenerates it; add a paragraph recording why that reasoning does not cover reviewer edits and approvals, so the next reader does not re-derive the gap.

- [ ] **Step 4: Full suite, typecheck, commit**

```bash
pnpm test && pnpm typecheck
git add src/cli/stateFiles.ts src/cli/state-push.ts src/cli/state-pull.ts tests
git commit -m "feat(state): snapshot the database, and track renderings"
```

---

## Done when

- `pnpm test` and `pnpm typecheck` pass
- `pnpm serve` runs against a local Postgres with no `output/` review state present
- `db:import` → `db:export` reproduces a tree byte for byte
- A resend never exposes a ledger without the room's row (Task 14b)
- `grep -rn "serialWrites\|withFileLock" src` returns nothing
- No command reads review state from `output/`; worksheets, config, watermarks and `publish/local/` still do

**Not in this plan:** running `db:import` against real data, provisioning a hosted database, any Vercel work, any auth work.
