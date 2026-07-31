import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { assertLedgerMigrated } from "../../src/cli/assertLedgerMigrated";
import { PgDeliveryLedger } from "../../src/adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../../src/adapters/store/PgXArticleLedger";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("assertLedgerMigrated", () => {
  it("refuses to send when the ledger is empty but a populated legacy file is still on disk", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "cutover-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "deliveries.json"),
      JSON.stringify([
        { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" },
      ]),
      "utf8",
    );
    await expect(assertLedgerMigrated(db, root)).rejects.toThrow(/db:import/);
  });

  it("stays silent for a genuinely fresh install — empty table, no legacy file", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "fresh-"));
    await expect(assertLedgerMigrated(db, root)).resolves.not.toThrow();
  });

  it("stays silent when the deliveries table already has rows, regardless of what disk holds", async () => {
    db = await createTestDb();
    await new PgDeliveryLedger(db).add({
      itemId: "x:1", type: "announcement", outletId: "tg-community",
      status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto",
    });
    const root = await mkdtemp(join(tmpdir(), "already-migrated-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(join(root, "publish", "deliveries.json"), JSON.stringify([{ stale: true }]), "utf8");
    await expect(assertLedgerMigrated(db, root)).resolves.not.toThrow();
  });

  it("refuses when only the legacy channels.json (pre-outlet) holds rows", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "legacy-only-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "channels.json"),
      JSON.stringify([{ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "auto", sentAt: "2026-07-29T00:00:00.000Z" }]),
      "utf8",
    );
    await expect(assertLedgerMigrated(db, root)).rejects.toThrow(/db:import/);
  });

  it("stays silent when deliveries.json is present but empty, even if channels.json has rows (exclusive-or)", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "exclusive-or-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(join(root, "publish", "deliveries.json"), "[]", "utf8");
    await writeFile(
      join(root, "publish", "channels.json"),
      JSON.stringify([{ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "auto", sentAt: "2026-07-29T00:00:00.000Z" }]),
      "utf8",
    );
    await expect(assertLedgerMigrated(db, root)).resolves.not.toThrow();
  });

  it("refuses to send when x_article_deliveries is empty but x-article.json still holds sent rows", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "x-article-cutover-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "x-article.json"),
      JSON.stringify([{ itemId: "x:1", sentAt: "2026-07-29T00:00:00.000Z" }]),
      "utf8",
    );
    await expect(assertLedgerMigrated(db, root)).rejects.toThrow(/db:import/);
  });

  it("stays silent when x_article_deliveries already has rows, regardless of what disk holds", async () => {
    db = await createTestDb();
    await new PgXArticleLedger(db).add({ itemId: "x:1", sentAt: "2026-07-29T00:00:00.000Z" });
    const root = await mkdtemp(join(tmpdir(), "x-article-already-migrated-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(join(root, "publish", "x-article.json"), JSON.stringify([{ stale: true }]), "utf8");
    await expect(assertLedgerMigrated(db, root)).resolves.not.toThrow();
  });

  it("checks the delivery ledger and the x-article ledger independently — one migrated, one not, still refuses", async () => {
    db = await createTestDb();
    // deliveries is "migrated" (has a row of its own); x_article_deliveries is not.
    await new PgDeliveryLedger(db).add({
      itemId: "x:1", type: "announcement", outletId: "tg-community",
      status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto",
    });
    const root = await mkdtemp(join(tmpdir(), "partial-migration-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "x-article.json"),
      JSON.stringify([{ itemId: "x:2", sentAt: "2026-07-29T00:00:00.000Z" }]),
      "utf8",
    );
    await expect(assertLedgerMigrated(db, root)).rejects.toThrow(/db:import/);
  });
});
