# Scheduled Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `config:push` and `state:push` on a daily systemd unit that aims at the production database, and make the few-shot corpus part of what `state:push` carries.

**Architecture:** Five independent changes. Tasks 1–2 add `few_shot_examples` as the eighth tracked item in the operational-state snapshot (push side, then restore side). Task 3 makes the manual path say which database it opened. Task 4 stops `config:push` stacking identical snapshots. Task 5 adds the unit that runs the two pushes daily. Tasks 1–4 are pure repo changes with tests; Task 5 is unit files plus the tests that guard them.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, PGlite (in-process Postgres for tests), systemd `--user` units, Google Drive via `ConfigDrive`.

**Spec:** `docs/superpowers/specs/2026-08-13-scheduled-backup-design.md`

## Global Constraints

- **Commit subjects are conventional-commit and English.** `type(scope): description` — enforced by `src/cli/check-commit-subject.ts`. A description whose Hangul count meets or exceeds its Latin-letter count is rejected. Korean terms inside an English sentence are fine.
- **User-facing CLI output in this repo is Korean.** Every `console.log` a person reads (`state:push`, `db:export`, `config:push`) is Korean; code comments, test names and commit messages are English. Follow the surrounding file.
- **Tests run without a live database.** `createTestDb()` (`tests/support/testDb.ts`) is PGlite in-process. Never point a test at `DATABASE_URL`.
- **Never print credentials.** `describeDbTarget(cfg)` (`src/config.ts:474`) returns `"host[:port]/dbname"` and is the only sanctioned way to name a database target.
- **Scheduled units run from `%h/.herald/app`.** `tests/deploy/workingDirectory.test.ts` derives the unit list from `deploy/*.timer` and fails any unit naming a development checkout.
- **Timer minutes must not collide.** Taken: `{07,37}` convert, `17` watch, `23` creds, `41` x-reconcile, `53` translate-check. `tests/deploy/credsTiming.test.ts` derives these from `deploy/` and asserts difference.
- Run `pnpm test` and `pnpm typecheck` before every commit.

---

### Task 1: Few-shot corpora enter the state snapshot (push side)

The eight corpora (`translation` + one per `ALL_TYPES` member) become tracked snapshot paths, read out of `few_shot_examples` in `ordinal` order. A row without `item_id` makes the whole push refuse.

**Files:**
- Create: `src/domain/state/fewShot.ts`
- Create: `tests/domain/state/fewShot.test.ts`
- Modify: `src/cli/stateFiles.ts` — `TRACKED_REL` block (~line 96) and `snapshotFromDb` (~line 128)
- Test: `tests/cli/stateFiles.test.ts` (create if absent)

**Interfaces:**
- Consumes: `PgFewShotStore` / `fewShotStoresByType` (`src/adapters/store/PgFewShotStore.ts`), `ALL_TYPES` (`src/domain/conversion/models.ts:20`), `FewShotExample` (`src/domain/translation/models.ts:47`), `jsonFileText` (`src/shared/store/jsonFile.ts`), `SnapshotFile` (`src/cli/stateFiles.ts`).
- Produces: `FEW_SHOT_REL: readonly string[]`, `fewShotScopeFor(rel: string): string | undefined`, `assertRestorableFewShot(examples: readonly FewShotExample[], scope: string): void` — all from `src/domain/state/fewShot.ts`. Task 2 uses all three.

- [ ] **Step 1: Write the failing test for the path/scope mapping and the guard**

Create `tests/domain/state/fewShot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FEW_SHOT_REL, fewShotScopeFor, assertRestorableFewShot } from "../../../src/domain/state/fewShot";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

describe("FEW_SHOT_REL", () => {
  it("names one path per corpus — translation plus every conversion type", () => {
    expect(FEW_SHOT_REL).toHaveLength(ALL_TYPES.length + 1);
    expect(FEW_SHOT_REL[0]).toBe("output/few-shot/translation.json");
    for (const type of ALL_TYPES) {
      expect(FEW_SHOT_REL).toContain(`output/few-shot/conversion.${type}.json`);
    }
  });

  it("does not reuse the db:export names, which mean a different artifact", () => {
    // `translation/few-shot.json` and `conversion/few-shot.<type>.json` are what `db:export` writes
    // for the db:export → db:import rollback path. They live in the steering directories and both
    // `config:push` and `deploy:freeze` deliberately exclude them. Colliding the two on one string
    // is the confusion this naming exists to avoid.
    for (const rel of FEW_SHOT_REL) {
      expect(rel.startsWith("output/few-shot/")).toBe(true);
    }
  });
});

describe("fewShotScopeFor", () => {
  it("maps every tracked path back to its store scope", () => {
    expect(fewShotScopeFor("output/few-shot/translation.json")).toBe("translation");
    for (const type of ALL_TYPES) {
      expect(fewShotScopeFor(`output/few-shot/conversion.${type}.json`)).toBe(`conversion:${type}`);
    }
  });

  it("returns undefined for anything else, so write() falls through to its own refusal", () => {
    expect(fewShotScopeFor("output/publish/deliveries.json")).toBeUndefined();
    expect(fewShotScopeFor("output/few-shot/conversion.nosuchtype.json")).toBeUndefined();
    expect(fewShotScopeFor("output/few-shot/../../etc/passwd")).toBeUndefined();
  });
});

describe("assertRestorableFewShot", () => {
  it("accepts examples that all carry an itemId", () => {
    expect(() =>
      assertRestorableFewShot([{ source: "a", target: "가", itemId: "x:1" }], "translation"),
    ).not.toThrow();
  });

  it("accepts an empty corpus", () => {
    expect(() => assertRestorableFewShot([], "translation")).not.toThrow();
  });

  it("refuses a corpus holding an itemId-less example, naming the scope and the count", () => {
    // `PgFewShotStore.add` is `insert ... on conflict (scope, item_id) do update`, and Postgres
    // never considers one null item_id equal to another. An itemId-less row therefore inserts a
    // DUPLICATE on every state:pull rather than upserting — a corpus that inflates a little at each
    // restore. Refusing at push time keeps the snapshot repeatedly restorable, which is the only
    // property that makes it a backup.
    expect(() =>
      assertRestorableFewShot(
        [
          { source: "a", target: "가", itemId: "x:1" },
          { source: "b", target: "나" },
        ],
        "conversion:x",
      ),
    ).toThrow(/conversion:x/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/domain/state/fewShot.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/domain/state/fewShot"`

- [ ] **Step 3: Write the module**

Create `src/domain/state/fewShot.ts`:

```ts
import { ALL_TYPES, type ConversionType } from "../conversion/models";
import type { FewShotExample } from "../translation/models";

/**
 * The few-shot corpora as operational-state snapshot paths — `translation` plus one per
 * `ALL_TYPES` member, derived rather than listed so a new conversion type needs no wiring here.
 *
 * **Deliberately NOT the `db:export` names.** `translation/few-shot.json` and
 * `conversion/few-shot.<type>.json` already mean something else: they are what `pnpm db:export`
 * writes for the `db:export` → `db:import` rollback path, they sit in the steering directories, and
 * both `config:push` and `deploy:freeze` exclude them by name (`src/domain/config/steering.ts`).
 * Reusing those strings inside a *state* snapshot would collide two different artifacts on one
 * path, and the next person to read a snapshot would have no way to tell which one they had.
 */
export const FEW_SHOT_REL: readonly string[] = [
  "output/few-shot/translation.json",
  ...ALL_TYPES.map((type) => `output/few-shot/conversion.${type}.json`),
];

const TRANSLATION_REL = "output/few-shot/translation.json";
const CONVERSION_REL = /^output\/few-shot\/conversion\.([a-z_]+)\.json$/;

/**
 * The `PgFewShotStore` scope a tracked path restores into, or `undefined` when the path is not one
 * of ours. `undefined` rather than a throw: `DbStateFileStore.write` asks this first and falls
 * through to its own "refusing to restore untracked operational-state file" error, so there is one
 * refusal message rather than two.
 *
 * The conversion branch checks the captured type against `ALL_TYPES` instead of trusting the
 * pattern. The path arrives from a *downloaded* snapshot and is about to select a database scope;
 * an unrecognised type must be refused, not written into a scope no reader will ever look in.
 */
export function fewShotScopeFor(rel: string): string | undefined {
  if (rel === TRANSLATION_REL) return "translation";
  const match = CONVERSION_REL.exec(rel);
  if (!match) return undefined;
  const type = match[1] as ConversionType;
  return ALL_TYPES.includes(type) ? `conversion:${type}` : undefined;
}

/**
 * Refuses a corpus that cannot survive being restored twice.
 *
 * The restore side replays `PgFewShotStore.add`, which is
 * `insert ... on conflict (scope, item_id) do update`. `item_id` is nullable and Postgres never
 * considers one null equal to another for a unique constraint's purposes — `few_shot_examples`
 * depends on that, since it is how the port's documented "otherwise appends" behaviour is
 * implemented (`src/adapters/db/schema.ts:198`). So an itemId-less row does not upsert on the way
 * back in; it inserts a second copy, and a third on the next pull.
 *
 * No such row exists today: both writers always supply one (`src/app/SaveTranslation.ts:79`,
 * `src/app/ApproveRendering.ts:76`), and production held 30 rows with 0 nulls when this was
 * measured on 2026-08-13. The only way one enters is a hand-edited or legacy JSON file through
 * `db:import`. A scheduled backup is exactly what would turn that from a theoretical hazard into a
 * corpus quietly growing at each restore, so the push refuses rather than writing a snapshot that
 * is unsafe to apply.
 */
export function assertRestorableFewShot(examples: readonly FewShotExample[], scope: string): void {
  const missing = examples.filter((ex) => ex.itemId === undefined).length;
  if (missing === 0) return;
  throw new Error(
    `few-shot corpus "${scope}" holds ${missing} example(s) without an itemId, which a restore would ` +
      `duplicate instead of upserting (unique (scope, item_id) does not constrain nulls). Refusing to ` +
      `push a snapshot that cannot be restored twice — give those rows an item_id and push again.`,
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/domain/state/fewShot.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Write the failing test for the snapshot read**

Create `tests/cli/stateFiles.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../support/testDb";
import { snapshotFromDb, createStateFileStore } from "../../src/cli/stateFiles";
import { PgFewShotStore, fewShotStoresByType } from "../../src/adapters/store/PgFewShotStore";
import { FEW_SHOT_REL } from "../../src/domain/state/fewShot";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("snapshotFromDb — few-shot corpora", () => {
  it("omits a corpus with no rows, like every other empty store", async () => {
    db = await createTestDb();
    const files = await snapshotFromDb(db);
    expect(files.map((f) => f.rel)).not.toContain("output/few-shot/translation.json");
  });

  it("writes the translation corpus at its tracked path", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가", itemId: "x:1" });
    await store.add({ source: "b", target: "나", itemId: "x:2" });

    const files = await snapshotFromDb(db);
    const file = files.find((f) => f.rel === "output/few-shot/translation.json");
    expect(file).toBeDefined();
    expect(JSON.parse(file!.body)).toEqual([
      { source: "a", target: "가", itemId: "x:1" },
      { source: "b", target: "나", itemId: "x:2" },
    ]);
  });

  it("preserves ordinal order, which is what the prompt reads", async () => {
    // PgFewShotStore.load() is `order by ordinal`, and translate:prepare / convert:prepare lay that
    // order straight into the prompt. A snapshot that recovers the right SET in the wrong ORDER
    // silently changes what the model sees, with nothing failing to say so.
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    for (const n of ["1", "2", "3", "4"]) await store.add({ source: n, target: n, itemId: `x:${n}` });

    const files = await snapshotFromDb(db);
    const body = files.find((f) => f.rel === "output/few-shot/translation.json")!.body;
    expect((JSON.parse(body) as { source: string }[]).map((e) => e.source)).toEqual(["1", "2", "3", "4"]);
  });

  it("writes each conversion type at its own tracked path", async () => {
    db = await createTestDb();
    const byType = fewShotStoresByType(db);
    await byType.x.add({ source: "sx", target: "tx", itemId: "x:1" });
    await byType.announcement.add({ source: "sa", target: "ta", itemId: "x:2" });

    const rels = (await snapshotFromDb(db)).map((f) => f.rel);
    expect(rels).toContain("output/few-shot/conversion.x.json");
    expect(rels).toContain("output/few-shot/conversion.announcement.json");
    expect(rels).not.toContain("output/few-shot/conversion.kol.json");
  });

  it("refuses the whole push when any corpus holds an itemId-less example", async () => {
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "a", target: "가" });
    await expect(snapshotFromDb(db)).rejects.toThrow(/itemId/);
  });

  it("tracked() lists the seven original paths plus every few-shot path", async () => {
    db = await createTestDb();
    const tracked = createStateFileStore(db).tracked();
    expect(tracked).toContain("output/translations/translations.json");
    expect(tracked).toContain("output/publish/state.json");
    for (const rel of FEW_SHOT_REL) expect(tracked).toContain(rel);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run tests/cli/stateFiles.test.ts`
Expected: FAIL — the corpus paths are absent from `snapshotFromDb`'s output and from `tracked()`

- [ ] **Step 7: Wire few-shot into `snapshotFromDb` and `tracked()`**

In `src/cli/stateFiles.ts`, add to the imports at the top:

```ts
import { PgFewShotStore, fewShotStoresByType } from "../adapters/store/PgFewShotStore";
import { ALL_TYPES } from "../domain/conversion/models";
import { FEW_SHOT_REL, assertRestorableFewShot, fewShotScopeFor } from "../domain/state/fewShot";
import type { FewShotExample } from "../domain/translation/models";
```

Leave `TRACKED_REL` exactly as it is — the seven stay positionally indexed (`TRACKED_REL[0]`…`[6]`) and nothing may disturb that. Append this comment and constant directly beneath it:

```ts
/**
 * The eighth tracked item, kept in its own list rather than appended to `TRACKED_REL` because that
 * array is indexed positionally by `snapshotFromDb` and `write()` below — an eighth literal there
 * would be fine, but eight *derived* entries would not, and splitting the two keeps the seven's
 * indices unarguable. `tracked()` concatenates them.
 *
 * `few_shot_examples` passes this file's own membership test — "everything the database holds that
 * cannot be rebuilt by re-running the pipeline." A few-shot row copies text that is already tracked
 * (`translations`, `variants`), but *which approvals became examples* is not reproducible and no
 * command re-derives the corpus from approved text. Re-running the pipeline yields no corpus at all.
 */
const FEW_SHOT_TRACKED = FEW_SHOT_REL;
```

In `snapshotFromDb`, after the `addArray(TRACKED_REL[5], ...)` line and before the `publishEntries` block, add:

```ts
  // Synchronous, like `addArray` above it — the `await`s below are on the `load()` calls only.
  const addFewShot = (rel: string, scope: string, rows: readonly FewShotExample[]) => {
    assertRestorableFewShot(rows, scope);
    if (rows.length > 0) files.push({ rel, body: jsonFileText(rows) });
  };

  addFewShot("output/few-shot/translation.json", "translation", await new PgFewShotStore(db, "translation").load());
  const fewShotByType = fewShotStoresByType(db);
  for (const type of ALL_TYPES) {
    addFewShot(`output/few-shot/conversion.${type}.json`, `conversion:${type}`, await fewShotByType[type].load());
  }
```

The corpora are read one at a time rather than with `Promise.all`, matching the sequential `addArray` calls above — `snapshotFromDb` runs against one connection and ordering the reads keeps the failure message pointing at a single corpus.

Change `tracked()` to:

```ts
  tracked(): readonly string[] {
    return [...TRACKED_REL, ...FEW_SHOT_TRACKED];
  }
```

- [ ] **Step 8: Run the tests**

Run: `pnpm vitest run tests/cli/stateFiles.test.ts tests/domain/state/fewShot.test.ts`
Expected: PASS (14 tests). `fewShotScopeFor` is imported but not yet used in `stateFiles.ts` — Task 2 uses it. If the build fails on an unused import, drop it from the import line here and add it back in Task 2.

- [ ] **Step 9: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. `tests/app/stateRoundTrip.test.ts` and `tests/app/pushState.test.ts` exercise `tracked()` and `snapshotFromDb`; if either asserts an exact seven-entry list, update it to the new list rather than trimming the feature.

- [ ] **Step 10: Commit**

```bash
git add src/domain/state/fewShot.ts tests/domain/state/fewShot.test.ts src/cli/stateFiles.ts tests/cli/stateFiles.test.ts
git commit -m "feat(state): snapshot the few-shot corpora, refusing itemId-less rows"
```

---

### Task 2: Few-shot restores from the snapshot (pull side)

`state:pull` writes the corpora back into `few_shot_examples`, in snapshot order, idempotently.

**Files:**
- Modify: `src/cli/stateFiles.ts` — `DbStateFileStore.write` (~line 175)
- Test: `tests/app/stateRoundTrip.test.ts`

**Interfaces:**
- Consumes: `fewShotScopeFor` and `FEW_SHOT_REL` from Task 1, `PgFewShotStore` (`add(ex: FewShotExample): Promise<void>`).
- Produces: nothing new. `DbStateFileStore.write(path, content)` keeps its signature.

- [ ] **Step 1: Write the failing round-trip test**

Append to `tests/app/stateRoundTrip.test.ts` (match the file's existing imports and its per-`it()` `const` binding convention — the file's own comment explains why it must not hold two `createTestDb()` results in a module-level `let`):

```ts
  it("restores every few-shot corpus into an empty database, in order", async () => {
    const source = await createTestDb();
    try {
      const store = new PgFewShotStore(source, "translation");
      for (const n of ["1", "2", "3"]) await store.add({ source: n, target: n, itemId: `x:${n}` });
      await fewShotStoresByType(source).x.add({ source: "sx", target: "tx", itemId: "x:9" });

      const snapshot = await createStateFileStore(source).list();

      const target = await createTestDb();
      try {
        const store2 = createStateFileStore(target);
        for (const f of snapshot) await store2.write(f.path, f.content);

        const restored = await new PgFewShotStore(target, "translation").load();
        expect(restored.map((e) => e.source)).toEqual(["1", "2", "3"]);
        expect(await fewShotStoresByType(target).x.load()).toEqual([
          { source: "sx", target: "tx", itemId: "x:9" },
        ]);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });

  it("a second pull of the same snapshot does not grow the corpus", async () => {
    // The property that makes this a backup rather than a one-shot: `add` upserts on
    // (scope, item_id), so replaying a snapshot is idempotent. Task 1's push-time guard is what
    // keeps it true, by refusing to snapshot a row whose null item_id would append instead.
    const source = await createTestDb();
    try {
      await new PgFewShotStore(source, "translation").add({ source: "a", target: "가", itemId: "x:1" });
      const snapshot = await createStateFileStore(source).list();

      const target = await createTestDb();
      try {
        const store2 = createStateFileStore(target);
        for (const f of snapshot) await store2.write(f.path, f.content);
        for (const f of snapshot) await store2.write(f.path, f.content);
        expect(await new PgFewShotStore(target, "translation").load()).toHaveLength(1);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });

  it("refuses a snapshot path that is shaped like a corpus but names no real type", async () => {
    const db = await createTestDb();
    try {
      await expect(
        createStateFileStore(db).write("output/few-shot/conversion.nosuchtype.json", "[]"),
      ).rejects.toThrow(/untracked operational-state file/);
    } finally {
      await db.close();
    }
  });
```

Add to that file's imports:

```ts
import { PgFewShotStore, fewShotStoresByType } from "../../src/adapters/store/PgFewShotStore";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/app/stateRoundTrip.test.ts`
Expected: FAIL — `refusing to restore untracked operational-state file: output/few-shot/translation.json`

- [ ] **Step 3: Add the restore branch**

In `src/cli/stateFiles.ts`, at the very top of `DbStateFileStore.write`, before the `switch (path)`:

```ts
  async write(path: string, content: string): Promise<void> {
    // Asked before the switch because the corpora are derived from ALL_TYPES, not literals a `case`
    // can name. `fewShotScopeFor` returns undefined for anything else, so an unrecognised path falls
    // through to the switch's own `default:` refusal and there is still exactly one refusal message.
    //
    // Replaying `add()` in array order is what preserves ordinal order: `ordinal` is a bigserial
    // assigned on insert, and `load()` reads `order by ordinal`. That order is prompt content — see
    // `assertRestorableFewShot`'s comment for why the same replay is also safe to run twice.
    const fewShotScope = fewShotScopeFor(path);
    if (fewShotScope !== undefined) {
      const store = new PgFewShotStore(this.db, fewShotScope);
      for (const ex of JSON.parse(content) as FewShotExample[]) await store.add(ex);
      return;
    }

    switch (path) {
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run tests/app/stateRoundTrip.test.ts`
Expected: PASS

- [ ] **Step 5: Update the Korean recovery documentation**

In `docs/ko/setup/steering.md` §5 ("잃어버렸을 때"), after the `config:pull` paragraph, add:

```markdown
> **few-shot 코퍼스는 여기가 아니라 `state:pull`입니다.** 데이터베이스가 비었으면 순서가 있습니다 —
> `pnpm db:import --yes`로 **스키마를 먼저 만들고**, 그다음 `pnpm state:pull --yes`가 채웁니다.
> 반대로 하면 넣을 테이블이 없습니다. 복원은 `(scope, item_id)` 기준 upsert라 여러 번 돌려도
> 코퍼스가 부풀지 않습니다.
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/cli/stateFiles.ts tests/app/stateRoundTrip.test.ts docs/ko/setup/steering.md
git commit -m "feat(state): restore the few-shot corpora from an operational-state snapshot"
```

---

### Task 3: The manual path says which database it opened

`pnpm state:push` and `pnpm db:export` run from the repo open the *development* database, silently. Both print their target; `state:push` additionally warns when that target is a development one.

**Files:**
- Create: `src/domain/state/target.ts`
- Create: `tests/domain/state/target.test.ts`
- Modify: `src/cli/state-push.ts:31-33`
- Modify: `src/cli/db-export.ts` (at the point it opens the database)

**Interfaces:**
- Consumes: `DbConfig` and `describeDbTarget(cfg: DbConfig): string` (`src/config.ts:428`, `:474`).
- Produces: `describeBackupTarget(cfg: DbConfig): string[]` — the lines to print, in order.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/state/target.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { describeBackupTarget } from "../../../src/domain/state/target";

describe("describeBackupTarget", () => {
  it("names the host and database, never the credentials", () => {
    const lines = describeBackupTarget({
      url: "postgres://postgres:hunter2@127.0.0.1:5432/herald",
      env: "development",
    });
    expect(lines.join("\n")).toContain("127.0.0.1:5432/herald");
    expect(lines.join("\n")).not.toContain("hunter2");
  });

  it("warns on a development target, because that is the accident", () => {
    // `EnvironmentFile=` is what selects the production database, not which tree the command runs
    // from — so `pnpm state:push` from the repo backs up local Docker while looking like it worked.
    const lines = describeBackupTarget({ url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" });
    expect(lines.some((l) => l.includes("⚠"))).toBe(true);
    expect(lines.join("\n")).toContain("development");
  });

  it("does not warn on a production target", () => {
    const lines = describeBackupTarget({ url: "postgres://u:p@ep-x.neon.tech/herald", env: "production" });
    expect(lines.some((l) => l.includes("⚠"))).toBe(false);
    expect(lines.join("\n")).toContain("ep-x.neon.tech/herald");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/domain/state/target.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/domain/state/target"`

- [ ] **Step 3: Write the module**

Create `src/domain/state/target.ts`:

```ts
import { describeDbTarget, type DbConfig } from "../../config";

/**
 * What a backup command prints before it does anything, so the operator can see which database it
 * actually opened.
 *
 * The warning exists because the failure is silent and the success message is identical either way.
 * `EnvironmentFile=%h/.herald/prod.env` is what points a command at Neon — not which checkout it
 * runs from — so `pnpm state:push` typed by hand in either tree opens local Docker and reports a
 * cheerful row count for a database nobody is trying to protect. Measured 2026-08-13: production
 * held 30 few-shot rows that had never been in a snapshot, while the local copy held 23.
 *
 * A warning, not a refusal. Snapshotting a development database is a legitimate deliberate act, and
 * `db:export`'s rollback path depends on exactly that. It must simply stop being the thing that
 * happens by accident.
 */
export function describeBackupTarget(cfg: DbConfig): string[] {
  const lines = [`데이터베이스: ${describeDbTarget(cfg)}  (HERALD_DB_ENV=${cfg.env})`];
  if (cfg.env === "development") {
    lines.push(
      "  ⚠ development 데이터베이스입니다. 프로덕션(Neon)을 백업하려면 DATABASE_URL과 " +
        "HERALD_DB_ENV=production 을 주고 돌리세요 — 스케줄 유닛은 ~/.herald/prod.env 로 그렇게 합니다.",
    );
  }
  return lines;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run tests/domain/state/target.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Print it from both commands**

In `src/cli/state-push.ts`, replace lines 31–33:

```ts
const drive = new GoogleConfigDrive(auth, fetch, DRIVE_LABEL);
const db = createDb(loadDbConfig());
try {
```

with:

```ts
const drive = new GoogleConfigDrive(auth, fetch, DRIVE_LABEL);
const dbConfig = loadDbConfig();
for (const line of describeBackupTarget(dbConfig)) console.log(line);
const db = createDb(dbConfig);
try {
```

and add to its imports:

```ts
import { describeBackupTarget } from "../domain/state/target";
```

`src/cli/db-export.ts` needs less: it already holds the config in a `const` (`:509`) and already prints the env at `:514`:

```ts
  console.log(`db:export — exporting the ${cfg.env} database into ${outputRoot}`);
```

That names the environment but never the host, which is the half that catches a wrong `DATABASE_URL`. Replace that one line with:

```ts
  console.log(`db:export — exporting into ${outputRoot}`);
  for (const line of describeBackupTarget(cfg)) console.log(line);
```

and add the same import. Do not restructure anything else in this file.

- [ ] **Step 6: Verify by running both commands against the local database**

Run: `pnpm state:push --help 2>&1 | head -5 || true`, then the real check:

```bash
pnpm db:export 2>&1 | head -3
```

Expected: the first lines name `127.0.0.1:5432/herald  (HERALD_DB_ENV=development)` and carry the `⚠`. Do **not** run `pnpm state:push` to check — it uploads a real snapshot to Drive.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/domain/state/target.ts tests/domain/state/target.test.ts src/cli/state-push.ts src/cli/db-export.ts
git commit -m "fix(state): name the database state:push and db:export opened, and warn on development"
```

---

### Task 4: `config:push` skips an unchanged bundle

Daily, an unconditional upload is ~365 near-identical snapshots a year in the folder whose whole value is that history is the rollback.

**Files:**
- Modify: `src/app/PushConfig.ts`
- Modify: `src/cli/config-push.ts` (report the skip)
- Test: `tests/app/pushConfig.test.ts`

**Interfaces:**
- Consumes: `ConfigDrive` (`upload`, `latest(folderId, prefix)`, `download(fileId)`), `assembleConfigBundle`, `parseConfigBundle` (`src/domain/config/bundle.ts`).
- Produces: `PushConfig.run(folderId: string): Promise<{ name: string; id: string; count: number; skipped: boolean }>` — `skipped: true` means nothing was uploaded and `name`/`id` name the existing newest snapshot.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/pushConfig.test.ts` (follow the file's existing fake-drive helper; if it has none, this is the shape):

```ts
  it("skips the upload when the newest snapshot holds the same files", async () => {
    // The bundle embeds `pushedAt`, so its raw text differs on every call — the comparison has to be
    // on the parsed file map, not the JSON. Comparing raw text would never match and the skip would
    // silently never fire.
    const uploads: { name: string; content: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "steering-config-2026-08-12T00-00-00-000Z.json" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(true);
    expect(res.id).toBe("old");
    expect(uploads).toHaveLength(0);
  });

  it("uploads when a file's content differs", async () => {
    const uploads: { name: string; content: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name, content) => { uploads.push({ name, content }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "steering-config-2026-08-12T00-00-00-000Z.json" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: '[{"ko":"온체인"}]\n' }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when a file was added, even though every existing file matches", async () => {
    const uploads: { name: string }[] = [];
    const existing = assembleConfigBundle(
      [{ path: "translation/glossary.json", content: "[]\n" }],
      () => "2026-08-12T00:00:00.000Z",
    );
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "x" }),
      download: async () => existing,
    };
    const files: ConfigFileStore = {
      list: async () => [
        { path: "translation/glossary.json", content: "[]\n" },
        { path: "translation/glossary-dismissed.json", content: "[]\n" },
      ],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when the folder is empty", async () => {
    const uploads: { name: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => undefined,
      download: async () => { throw new Error("must not download when there is no snapshot"); },
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it("uploads when the newest snapshot cannot be parsed", async () => {
    // A corrupt or truncated newest snapshot must not be read as "same, skip" — that would leave the
    // corpus with no good copy at exactly the moment its newest one is broken.
    const uploads: { name: string }[] = [];
    const drive: ConfigDrive = {
      upload: async (_f, name) => { uploads.push({ name }); return { id: "new" }; },
      latest: async () => ({ id: "old", name: "x" }),
      download: async () => "{ not json",
    };
    const files: ConfigFileStore = {
      list: async () => [{ path: "translation/glossary.json", content: "[]\n" }],
      write: async () => {},
      backup: async () => {},
    };

    const res = await new PushConfig(files, drive, () => "2026-08-13T00:00:00.000Z").run("folder");
    expect(res.skipped).toBe(false);
    expect(uploads).toHaveLength(1);
  });
```

Add to that file's imports:

```ts
import { assembleConfigBundle } from "../../src/domain/config/bundle";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import type { ConfigFileStore } from "../../src/ports/ConfigFileStore";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/app/pushConfig.test.ts`
Expected: FAIL — `res.skipped` is `undefined`, and the upload count is 1 where 0 is expected

- [ ] **Step 3: Rewrite `PushConfig`**

Replace `src/app/PushConfig.ts` entirely:

```ts
import type { ConfigFileStore } from "../ports/ConfigFileStore";
import type { ConfigDrive } from "../ports/ConfigDrive";
import { assembleConfigBundle, parseConfigBundle, type ConfigFile } from "../domain/config/bundle";
import { STEERING_SNAPSHOT_PREFIX } from "../domain/config/steering";

export interface PushConfigResult {
  name: string;
  id: string;
  count: number;
  /** `true` when the newest snapshot already held these exact files and nothing was uploaded. */
  skipped: boolean;
}

/** Same files, same bytes — order-independent, since the bundle stores a map. */
function sameFiles(a: ConfigFile[], b: ConfigFile[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Map(a.map((f) => [f.path, f.content]));
  return b.every((f) => left.get(f.path) === f.content);
}

export class PushConfig {
  constructor(
    private readonly files: ConfigFileStore,
    private readonly drive: ConfigDrive,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Uploads one timestamped snapshot, **unless the newest one already holds these exact files.**
   *
   * Without the skip this uploads unconditionally, which was fine while every push was a human
   * reacting to an edit. On a daily timer it is ~365 near-identical snapshots a year in a folder
   * whose entire value is that its history is the rollback: finding the version before a bad edit
   * becomes a binary search through duplicates. Manual pushes get the same behaviour, which is also
   * right — pushing twice after one edit should not produce two snapshots either.
   *
   * The comparison is on the PARSED file map, never the bundle text: `assembleConfigBundle` embeds
   * `pushedAt`, so the raw JSON differs on every call and a text comparison would never match.
   *
   * Any failure to read the newest snapshot — absent, malformed, truncated — falls through to
   * uploading. The one thing worse than a duplicate snapshot is treating an unreadable newest
   * snapshot as "same, skip" and leaving the corpus with no good copy.
   */
  async run(folderId: string): Promise<PushConfigResult> {
    const files = await this.files.list();

    const newest = await this.drive.latest(folderId, STEERING_SNAPSHOT_PREFIX);
    if (newest) {
      try {
        if (sameFiles(parseConfigBundle(await this.drive.download(newest.id)), files)) {
          return { name: newest.name, id: newest.id, count: files.length, skipped: true };
        }
      } catch {
        // fall through and upload
      }
    }

    const stamp = this.now();
    const bundle = assembleConfigBundle(files, () => stamp);
    const name = `${STEERING_SNAPSHOT_PREFIX}${stamp.replace(/[:.]/g, "-")}.json`;
    const { id } = await this.drive.upload(folderId, name, bundle);
    return { name, id, count: files.length, skipped: false };
  }
}
```

- [ ] **Step 4: Add the shared prefix constant**

`PullConfig` currently hardcodes `"steering-config-"` (`src/app/PullConfig.ts:28`) and `PushConfig` built the same string inline. Two copies of the string that decides which files are the steering snapshots is one copy too many now that both sides read it. In `src/domain/config/steering.ts`, add:

```ts
/** Drive file-name prefix for a steering snapshot. `latest()` matches on it, so it must not be a
 *  prefix of any other bundle — the state snapshot's is `operational-state-`. */
export const STEERING_SNAPSHOT_PREFIX = "steering-config-";
```

Then in `src/app/PullConfig.ts`, import it and replace the literal `"steering-config-"` in the `this.drive.latest(...)` call.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run tests/app/pushConfig.test.ts tests/app/pullConfig.test.ts`
Expected: PASS

- [ ] **Step 6: Report the skip in the CLI**

In `src/cli/config-push.ts`, find where it logs the result and make the skip visible rather than reporting an upload that did not happen. The Korean line:

```ts
console.log(
  res.skipped
    ? `변경 없음 — 올리지 않았습니다. 최신 스냅샷 그대로: ${res.name}`
    : `${res.count}개 파일을 올렸습니다 → ${res.name} (${res.id})`,
);
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/app/PushConfig.ts src/app/PullConfig.ts src/domain/config/steering.ts src/cli/config-push.ts tests/app/pushConfig.test.ts
git commit -m "feat(config): skip the upload when config:push would repeat the newest snapshot"
```

---

### Task 5: The `herald-backup` unit

One daily unit runs both pushes against the production database.

**Files:**
- Create: `deploy/herald-backup.service`
- Create: `deploy/herald-backup.timer`
- Modify: `docs/ko/setup/steering.md` §6
- Modify: `docs/ko/team-runbook.md` (the scheduled-units section)

**Interfaces:**
- Consumes: `deploy/herald-run-logged.sh` (`$1` = unit name, rest = command, run verbatim), `deploy/herald-notify-failure@.service`, `pnpm config:push` and `pnpm state:push` as `package.json` scripts.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Verify the timer minute is free and parses**

Run:

```bash
grep -h OnCalendar deploy/*.timer
systemd-analyze calendar '*-*-* 05:47:00'
```

Expected: the existing minutes are `{07,37}`, `17`, `23`, `41`, `53` — `47` is absent. `systemd-analyze` normalises to itself and prints a next elapse. Record that output; the timer's header cites it.

- [ ] **Step 2: Write the service unit**

Create `deploy/herald-backup.service`:

```ini
# deploy/herald-backup.service
#
# systemd --user unit for one daily backup: the steering configuration to Drive, then the
# operational state — including the few-shot corpora — out of the PRODUCTION database.
#
# Why this exists: both pushes were manual, and one of them was aimed wrong. `EnvironmentFile=`
# below is what selects Neon; it is not which tree the command runs from. So `pnpm state:push` typed
# by hand in either checkout opens local Docker and reports a cheerful row count. Measured
# 2026-08-13: production held 30 few-shot rows that had never been in any snapshot, against 23 in
# the local database that `db:export` had been writing to disk. See
# docs/superpowers/specs/2026-08-13-scheduled-backup-design.md.
#
# NOT installed by any committed script. Copying this into ~/.config/systemd/user/ and running
# `systemctl --user daemon-reload` is a human-supervised step (see the team runbook), same as the
# other five units.

[Unit]
Description=Mantle KR Herald daily backup — steering configuration and production operational state
OnFailure=herald-notify-failure@%n.service

[Service]
Type=oneshot
# The deploy checkout — merged `main` only. tests/deploy/workingDirectory.test.ts fails if this ever
# names a development checkout.
#
# Reading the steering files from HERE rather than the development tree is deliberate and was
# measured: `deploy/herald-deploy.sh` copies them across at deploy time, and on 2026-08-13 all 13
# were byte-identical between the two trees. The two disagree only between an edit and the next
# deploy, and `pnpm doctor`'s `Steering deploy sync` line already reports exactly that window. A
# `--from` flag pointing back at the development tree would buy that window at the cost of the
# invariant every other unit depends on.
WorkingDirectory=%h/.herald/app

Environment=PATH=%h/.herald/bin:/home/kyle/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# This is the whole point of the unit: `prod.env` holds exactly two keys — DATABASE_URL and
# HERALD_DB_ENV — and a shell-exported variable beats Node's --env-file, so those two override the
# frozen .env's local-Docker values while everything else (GOOGLE_AUTH_MODE=oauth, the OAuth refresh
# token, GDRIVE_CONFIG_FOLDER_ID, GDRIVE_STATE_FOLDER_ID) still comes from .env. Re-verified for the
# spec on this machine:
#
#   $ HERALD_PROBE=from_systemd tsx --env-file-if-exists=.env p.ts   # .env has HERALD_PROBE=from_dotenv
#   HERALD_PROBE = from_systemd
#
# Removing this line does not disable the backup; it silently backs up the development database.
EnvironmentFile=%h/.herald/prod.env

# Two Drive uploads and two database reads. A real run is seconds. 300s is a generous multiple that
# still fails long before a daily cadence could overlap itself.
TimeoutStartSec=300

# config:push FIRST, deliberately: it is the cheap one, it cannot fail on database state, and if the
# database is unreachable the steering snapshot has still been taken. Both are wrapped in
# herald-run-logged.sh for the reason every other unit is — journald on this box holds roughly eight
# minutes of history. Argument order is that wrapper's contract: `$1` is the unit name, everything
# after it is the command.
#
# Type=oneshot runs these in order and fails the unit if either exits non-zero, which is what the
# OnFailure= hook above depends on.
ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm config:push
ExecStart=%h/.herald/app/deploy/herald-run-logged.sh %n %h/.herald/bin/pnpm state:push
```

- [ ] **Step 3: Write the timer unit**

Create `deploy/herald-backup.timer`:

```ini
# deploy/herald-backup.timer
#
# Fires herald-backup.service once a day at 05:47, before the working day and before
# herald-creds.timer's 06:23.
#
# Daily, not hourly. The steering files change a few times a month; the operational state changes
# through the day but Neon's own restore covers the hours between fires. Hourly would mean 24 Drive
# snapshots a day, which is the noise `config:push`'s skip-if-unchanged exists to prevent in the
# first place.
#
# :47 is off :00 and off :07/:37 (convert), :17 (watch), :23 (creds), :41 (x-reconcile) and :53
# (translate-check) specifically: units sharing a minute buy nothing and invite two pnpm processes
# starting at once. tests/deploy/credsTiming.test.ts derives the other timers' minutes from deploy/
# and asserts they differ, so a later edit cannot collide unnoticed.
#
# NOT installed by any committed script — see herald-backup.service's header.

[Unit]
Description=Timer for herald-backup.service — daily steering and operational-state backup

[Timer]
OnCalendar=*-*-* 05:47:00
# Runs once on the next boot/login if the machine was off (or the user manager wasn't running —
# WSL2's usual failure mode) through a scheduled fire, instead of silently skipping the day.
Persistent=true

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Run the deploy tests, which pick the new unit up automatically**

Run: `pnpm vitest run tests/deploy/`
Expected: PASS. Both `workingDirectory.test.ts` and `credsTiming.test.ts` derive their unit lists from `deploy/*.timer`, so the new unit is checked without either file being edited. A failure here means the `WorkingDirectory=` or the minute is wrong — fix the unit, not the test.

- [ ] **Step 5: Verify the timer's calendar expression**

Run: `systemd-analyze calendar '*-*-* 05:47:00'`
Expected: `Normalized form: *-*-* 05:47:00` and a next-elapse line. Paste that output into the commit message.

- [ ] **Step 6: Document it**

In `docs/ko/setup/steering.md` §6, after the `config:push`/`config:pull` block, add:

```markdown
### 자동 백업 — `herald-backup.timer`

2026-08-13부터 매일 05:47에 `config:push`와 `state:push`가 자동으로 돕니다. 유닛이
`~/.herald/prod.env`를 읽으므로 **`state:push`는 프로덕션(Neon)을 백업합니다** — 손으로 돌릴 때와
다른 지점이니 주의하세요(손으로 돌리면 개발 DB입니다. 명령이 첫 줄에 어느 DB에 붙었는지 찍습니다).

`config:push`는 내용이 최신 스냅샷과 같으면 **올리지 않습니다.** "변경 없음"이 정상 출력입니다.

수동 `pnpm config:push`는 그대로 유효하고 권장됩니다 — 타이머는 잊었을 때의 안전망이지, 편집한
사람이 밀지 않아도 된다는 뜻이 아닙니다. 하루 안에 사고가 나면 타이머는 아직 안 돌았습니다.
```

In `docs/ko/team-runbook.md`, add `herald-backup` to the scheduled-units list with its cadence, matching the surrounding entries' format.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add deploy/herald-backup.service deploy/herald-backup.timer docs/ko/setup/steering.md docs/ko/team-runbook.md
git commit -m "feat(deploy): add a daily unit backing up steering and production state"
```

- [ ] **Step 9: Note the install order for the human step**

The unit files are committed but **not installed**. Installing them is a human-supervised step and must happen in this order, because the unit names a wrapper that lives in the deploy checkout:

```bash
bash deploy/herald-deploy.sh                  # lands this commit in ~/.herald/app FIRST
cp deploy/herald-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now herald-backup.timer
systemctl --user list-timers herald-backup.timer     # confirm next elapse
```

Report this to the user at the end rather than running it — `herald-deploy.sh` deploys, and `state:push` uploads to Drive.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §"What is actually broken" — manual path opens the development database | Task 3 |
| §1 One unit `herald-backup`, daily 05:47, two `ExecStart=`, `prod.env` | Task 5 |
| §2 `output/few-shot/…` paths, not the `db:export` names | Task 1 |
| §2 ordinal order preserved | Task 1 (push order test), Task 2 (restore order test) |
| §2 `scope` travels with the row | Task 1 (`FEW_SHOT_REL` / `fewShotScopeFor`) |
| §2 itemId-less rows refused at push time | Task 1 |
| §2 `countRows` recognises the shape | **No task needed** — few-shot serialises as a bare JSON array, which `countRows` (`src/domain/state/snapshot.ts`) already counts via its `Array.isArray` branch. The spec asked for a change that turns out to be already satisfied; Task 1 Step 9's full-suite run is what proves it, since `state:pull`'s preview is built from `countRows`. |
| §2 `unknownStatePaths` compatibility via `tracked()` | Task 1 Step 7 (`tracked()` concatenation) + Task 2 Step 1 (the unknown-type refusal test) |
| §2 recovery order documented | Task 2 Step 5 |
| §2 round-trip test | Task 2 |
| §3 print the target, warn on development | Task 3 |
| §4 `config:push` skips an unchanged bundle | Task 4 |

**Placeholder scan:** none — every code step carries the code, every test step carries the test body, and every run step names the command and the expected result.

**Type consistency:** `FEW_SHOT_REL`, `fewShotScopeFor`, `assertRestorableFewShot` are defined in Task 1 Step 3 and used with those exact names in Task 1 Step 7 and Task 2 Step 3. `describeBackupTarget` is defined and consumed in Task 3. `PushConfigResult.skipped` is defined in Task 4 Step 3 and read in Task 4 Steps 1 and 6. `STEERING_SNAPSHOT_PREFIX` is added in Task 4 Step 4 and consumed by both `PushConfig` and `PullConfig`.

**One thing the implementer will hit:** Task 4 Step 4 moves a string literal that `PullConfig` also uses. If `tests/app/pullConfig.test.ts` asserts on the literal `"steering-config-"`, that is fine — the constant holds the same value; the test does not need changing.
