import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { importOutputTree, previewImport } from "../../src/cli/db-import";
import { PgTranslationStore } from "../../src/adapters/store/PgTranslationStore";
import { PgDeliveryLedger } from "../../src/adapters/store/PgDeliveryLedger";
import { JsonDeliveryLedger } from "../../src/adapters/store/JsonDeliveryLedger";

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

  it("imports the legacy channels.json fallback when deliveries.json is absent", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "import-legacy-"));
    await mkdir(join(root, "publish"), { recursive: true });
    const legacy = [{ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "auto", sentAt: "2026-01-01T00:00:00.000Z" }];
    await writeFile(join(root, "publish", "channels.json"), JSON.stringify(legacy, null, 2) + "\n", "utf8");

    await importOutputTree(db, root);
    await importOutputTree(db, root); // idempotent on a second run against the same tree too
    expect(await new PgDeliveryLedger(db).loadAll()).toHaveLength(1);
  });

  it("ignores channels.json entirely once deliveries.json exists, even empty — the exclusive-or is not a union", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "import-exclusive-or-"));
    await mkdir(join(root, "publish"), { recursive: true });
    const legacy = [{ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "auto", sentAt: "2026-01-01T00:00:00.000Z" }];
    await writeFile(join(root, "publish", "channels.json"), JSON.stringify(legacy, null, 2) + "\n", "utf8");
    await writeFile(join(root, "publish", "deliveries.json"), "[]\n", "utf8");

    const report = await importOutputTree(db, root);
    expect(report.deliveries).toBe(0);
    expect(await new PgDeliveryLedger(db).loadAll()).toHaveLength(0);
  });

  /**
   * Pins the *mechanism*, not just the outcome of the two tests above: the exclusive-or rule lives
   * in `JsonDeliveryLedger.loadAll()`, and import must inherit it by calling that method rather than
   * by re-deriving the same behavior from reading `deliveries.json`/`channels.json` separately. A
   * future "optimization" that reads both files directly could reproduce the outcome of the tests
   * above by accident (e.g. checking "does deliveries.json exist" instead of delegating) while still
   * being one bad edge case away from a union; this is what would actually catch that refactor,
   * since it fails the moment `importOutputTree` stops calling `JsonDeliveryLedger.prototype.loadAll`
   * at all.
   */
  it("reads deliveries through JsonDeliveryLedger.loadAll() rather than the two files directly", async () => {
    db = await createTestDb();
    const spy = vi.spyOn(JsonDeliveryLedger.prototype, "loadAll");
    try {
      await importOutputTree(db, await tree());
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("previewImport", () => {
  it("reports current-vs-incoming counts without writing anything", async () => {
    db = await createTestDb();
    const localDb = db;
    await new PgTranslationStore(localDb).upsert({
      itemId: "already:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "translated", translatedAt: "2026-01-01T00:00:00.000Z",
    });

    const preview = await previewImport(localDb, await tree());
    expect(preview.translations).toEqual({ current: 1, incoming: 1 });

    // Read-only: the one row already in the database is still the only one there.
    expect(await new PgTranslationStore(localDb).loadAll()).toHaveLength(1);
  });

  it("reports zero-zero for every store on an empty database and an empty tree", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "preview-empty-"));
    const preview = await previewImport(db, root);
    for (const key of Object.keys(preview) as (keyof typeof preview)[]) {
      expect(preview[key]).toEqual({ current: 0, incoming: 0 });
    }
  });
});
