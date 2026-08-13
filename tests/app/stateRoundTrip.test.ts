import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbStateFileStore } from "../../src/cli/stateFiles";
import { PullState } from "../../src/app/PullState";
import { PushState } from "../../src/app/PushState";
import type { ConfigDrive } from "../../src/ports/ConfigDrive";
import { createTestDb } from "../support/testDb";
import { PgTranslationStore } from "../../src/adapters/store/PgTranslationStore";
import { PgFormattingStore } from "../../src/adapters/store/PgFormattingStore";
import { PgDeliveryLedger } from "../../src/adapters/store/PgDeliveryLedger";
import { PgPublishStore } from "../../src/adapters/store/PgPublishStore";
import { PgFewShotStore, fewShotStoresByType } from "../../src/adapters/store/PgFewShotStore";
import { createStateFileStore } from "../../src/cli/stateFiles";

/** An in-memory stand-in for the Drive folder: newest upload wins, exactly like `latest()`. */
function memoryDrive(): ConfigDrive {
  const files = new Map<string, { name: string; content: string }>();
  let n = 0;
  return {
    upload: async (_folder, name, content) => {
      const id = `f${++n}`;
      files.set(id, { name, content });
      return { id };
    },
    latest: async (_folder, prefix) => {
      const match = [...files.entries()].filter(([, f]) => f.name.includes(prefix)).at(-1);
      return match ? { id: match[0], name: match[1].name } : undefined;
    },
    download: async (id) => files.get(id)!.content,
  };
}

describe("state:push → state:pull round trip (database-backed, Task 19)", () => {
  /**
   * `source`/`restored`/`archiveDir` used to be module-level `let`s, torn down in a shared
   * `afterEach`. That is safe as long as every test's own body finishes before the next one starts
   * — which a `testTimeout` does not guarantee: vitest reports a timed-out test as failed and moves
   * on, but never cancels its still-running body. This file is the only one in the suite that ever
   * holds two `createTestDb()` results live at once (`source` *and* `restored`), so it is the only
   * one where that matters: if test A times out between acquiring `source` and acquiring `restored`,
   * its body is still running when test B starts and reassigns the shared `source` binding to test
   * B's own database — and test A's leftover `new Pg*Store(source)` calls, once they finally get a
   * turn, then write test A's data straight into test B's database. `tests/support/testDb.ts`'s
   * pooling guard cannot catch this: it protects a *stale* reference to an already-`close()`d `Db`,
   * but this is a *live*, not-yet-closed `Db` reached through a binding that changed identity out
   * from under a still-running caller. Per-`it()` `const` locals and a `try`/`finally` close that:
   * a later test can never reassign what an earlier test's own local variable points to, so a
   * leftover call can only ever touch the database it was actually given.
   */
  it("reproduces every populated store on a rebuilt (fresh, empty) database", async () => {
    const source = await createTestDb();
    const restored = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "herald-state-archive-"));
    try {
      await new PgTranslationStore(source).upsert({
        itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
        status: "approved", translatedAt: "2026-07-01T00:00:00.000Z",
      });
      await new PgFormattingStore(source).upsert({
        itemId: "x:1", type: "announcement", channel: "telegram", text: "방별 포크 — 다시 만들 수 없음",
        refined: false, createdAt: "2026-07-01T00:00:00.000Z", status: "approved",
      });
      await new PgDeliveryLedger(source).add({
        itemId: "x:1", type: "announcement", outletId: "tg-community",
        status: "sent", at: "2026-07-01T00:00:00.000Z", by: "auto",
      });
      await new PgPublishStore(source).record({ itemId: "x:1", stage: "translation", status: "approved", target: "gdrive" });

      const drive = memoryDrive();
      const pushed = await new PushState(new DbStateFileStore(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");
      expect(pushed!.files.map((f) => f.rows)).toEqual([1, 1, 1, 1]);

      const target = new DbStateFileStore(restored);
      expect(await target.list()).toEqual([]); // nothing survived the rebuild

      const res = await new PullState(target, drive, archiveDir).run("FOLDER", { apply: true });

      expect(res!.restored).toBe(4);
      expect(res!.diff.every((d) => d.change === "restore")).toBe(true);

      expect(await new PgTranslationStore(restored).loadAll()).toHaveLength(1);
      expect(await new PgFormattingStore(restored).loadAll()).toHaveLength(1);
      expect(await new PgDeliveryLedger(restored).loadAll()).toHaveLength(1);
      expect(await new PgPublishStore(restored).listEntries()).toHaveLength(1);
    } finally {
      await source.close();
      await restored.close();
      await rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("imports over the target database rather than replacing it, and backs up its pre-pull state to disk first", async () => {
    const source = await createTestDb();
    const restored = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "herald-state-archive-"));
    try {
      await new PgDeliveryLedger(source).add({
        itemId: "x:1", type: "announcement", outletId: "tg-community",
        status: "sent", at: "2026-07-01T00:00:00.000Z", by: "auto",
      });
      const drive = memoryDrive();
      await new PushState(new DbStateFileStore(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");

      // The target database already has its own, different, delivery row.
      await new PgDeliveryLedger(restored).add({
        itemId: "x:99", type: "announcement", outletId: "tg-dev",
        status: "sent", at: "2026-07-01T00:00:00.000Z", by: "auto",
      });

      const res = await new PullState(new DbStateFileStore(restored), drive, archiveDir, () => "2026-07-30T00:00:00.000Z").run(
        "FOLDER",
        { apply: true },
      );
      expect(res!.diff.find((d) => d.path === "output/publish/deliveries.json")).toEqual({
        path: "output/publish/deliveries.json", current: 1, incoming: 1, change: "overwrite",
      });

      // Import, not replace: x:99 (never in the snapshot) survives; x:1 (the snapshot's row) arrives too.
      const rows = await new PgDeliveryLedger(restored).loadAll();
      expect(rows.map((r) => r.itemId).sort()).toEqual(["x:1", "x:99"]);

      // The pre-pull database state (x:99 only) is still recoverable as a real file — the operator's
      // rollback if the merge above was not what they wanted.
      const backedUp = JSON.parse(
        await readFile(join(archiveDir, "state-2026-07-30T00-00-00-000Z", "output/publish/deliveries.json"), "utf8"),
      ) as { itemId: string }[];
      expect(backedUp.map((r) => r.itemId)).toEqual(["x:99"]);
    } finally {
      await source.close();
      await restored.close();
      await rm(archiveDir, { recursive: true, force: true });
    }
  });

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

  it("restores the snapshot's corpus order onto a divergent database, not the target's", async () => {
    // The realistic shape of this restore, and the one an empty-target round trip cannot see:
    // production holds 30 few-shot rows, development 23, and pulling production's snapshot onto
    // development is the whole point of the feature. Replaying `add()` alone upserted the rows the
    // target already had IN PLACE — `on conflict … do update` never reassigns `ordinal` — so the
    // target's own order survived and the snapshot's new rows were appended behind it. `load()` is
    // `order by ordinal` and that order goes straight into the prompt.
    const source = await createTestDb();
    const restored = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "herald-state-archive-"));
    try {
      const upstream = new PgFewShotStore(source, "translation");
      for (const n of ["A", "B", "C"]) await upstream.add({ source: n, target: n, itemId: `x:${n}` });

      const drive = memoryDrive();
      await new PushState(new DbStateFileStore(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");

      // The target already holds the LAST of the three and nothing else.
      await new PgFewShotStore(restored, "translation").add({ source: "C", target: "C", itemId: "x:C" });

      await new PullState(new DbStateFileStore(restored), drive, archiveDir, () => "2026-07-30T00:00:00.000Z").run(
        "FOLDER",
        { apply: true },
      );

      const after = await new PgFewShotStore(restored, "translation").load();
      expect(after.map((e) => e.source)).toEqual(["A", "B", "C"]);
    } finally {
      await source.close();
      await restored.close();
      await rm(archiveDir, { recursive: true, force: true });
    }
  });

  it("previews and backs up a target holding an itemId-less row instead of refusing to run", async () => {
    // An `item_id is null` assertion used to throw from inside `snapshotFromDb`, which backs
    // `StateFileStore.list()` — and `PullState.run` calls `list()` for its preview and again through
    // `backup()`. So ONE legacy row in the TARGET database killed `pnpm state:pull` outright, with
    // or without `--yes`, quoting advice about pushing while no push was happening. The documented
    // recovery order (`pnpm db:import --yes` → `pnpm state:pull --yes`) is precisely how such a row
    // gets there: db:import inserts corpus JSON verbatim, `ex.itemId ?? null` included. No path
    // grades corpus content any more — `pnpm doctor` reports it (`src/doctor/fewShot.ts`).
    const source = await createTestDb();
    const restored = await createTestDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "herald-state-archive-"));
    try {
      await new PgFewShotStore(source, "translation").add({ source: "A", target: "가", itemId: "x:1" });
      const drive = memoryDrive();
      await new PushState(new DbStateFileStore(source), drive, () => "2026-07-29T00:00:00.000Z").run("FOLDER");

      // The legacy row, in the database being restored INTO.
      await new PgFewShotStore(restored, "translation").add({ source: "legacy", target: "레거시" });

      const preview = await new PullState(new DbStateFileStore(restored), drive, archiveDir).run("FOLDER");
      expect(preview!.applied).toBe(false);
      expect(preview!.diff.find((d) => d.path === "output/few-shot/translation.json")?.change).toBe("overwrite");

      const applied = await new PullState(
        new DbStateFileStore(restored),
        drive,
        archiveDir,
        () => "2026-07-30T00:00:00.000Z",
      ).run("FOLDER", { apply: true });
      expect(applied!.applied).toBe(true);

      // The pre-pull corpus, legacy row and all, is on disk as the operator's rollback.
      const backedUp = JSON.parse(
        await readFile(join(archiveDir, "state-2026-07-30T00-00-00-000Z", "output/few-shot/translation.json"), "utf8"),
      ) as { source: string }[];
      expect(backedUp.map((e) => e.source)).toEqual(["legacy"]);

      expect(await new PgFewShotStore(restored, "translation").load()).toEqual([
        { source: "A", target: "가", itemId: "x:1" },
      ]);
    } finally {
      await source.close();
      await restored.close();
      await rm(archiveDir, { recursive: true, force: true });
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
});
