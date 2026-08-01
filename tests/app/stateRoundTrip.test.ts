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
});
