import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgXArticleLedger } from "../../../src/adapters/store/PgXArticleLedger";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("PgXArticleLedger", () => {
  it("records a posted itemId and reports it, upserting by itemId", async () => {
    db = await createTestDb();
    const ledger = new PgXArticleLedger(db);
    expect(await ledger.loadKeys()).toEqual(new Set());

    await ledger.add({ itemId: "x:1", postId: "111", url: "https://x.com/i/article/111", sentAt: "2026-07-28T00:00:00Z" });
    await ledger.add({ itemId: "x:1", postId: "222", sentAt: "2026-07-28T01:00:00Z" }); // same id → upsert, not a second row
    const keys = await ledger.loadKeys();
    expect(keys.has("x:1")).toBe(true);
    expect(keys.size).toBe(1);

    await ledger.add({ itemId: "x:2", sentAt: "2026-07-28T02:00:00Z" });
    expect((await ledger.loadKeys()).size).toBe(2);
  });

  it("keeps both rows when two adds overlap", async () => {
    db = await createTestDb();
    const ledger = new PgXArticleLedger(db);
    await Promise.all([
      ledger.add({ itemId: "x:1", postId: "1", sentAt: "2026-07-29T00:00:00Z" }),
      ledger.add({ itemId: "x:2", postId: "2", sentAt: "2026-07-29T00:00:01Z" }),
    ]);
    const ids = new Set((await ledger.loadAll()).map((e) => e.itemId));
    expect(ids.has("x:1")).toBe(true);
    expect(ids.has("x:2")).toBe(true);
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const ledger = new PgXArticleLedger(db);
    await ledger.add({ itemId: "x:1", sentAt: "2026-07-28T00:00:00Z" });
    const [row] = await ledger.loadAll();
    expect(row).not.toHaveProperty("postId", null);
    expect(row?.postId).toBeUndefined();
    expect(row?.url).toBeUndefined();
    expect(row?.droppedAt).toBeUndefined();
  });

  /**
   * `droppedAt` marks a row whose Typefully draft was deleted before it published — nothing reached
   * the account. `loadKeys()` gates `SendXArticle.run()`'s re-send check, so a dropped row must stop
   * counting there, while `loadAll()` keeps it so the board can still explain what happened to it.
   */
  it("omits a row with droppedAt from loadKeys, but keeps it in loadAll", async () => {
    db = await createTestDb();
    const ledger = new PgXArticleLedger(db);
    await ledger.add({ itemId: "x:1", postId: "111", sentAt: "2026-07-28T00:00:00Z", droppedAt: "2026-07-29T00:00:00Z" });
    expect(await ledger.loadKeys()).toEqual(new Set());
    expect(await ledger.loadAll()).toHaveLength(1);
  });

  it("keeps a row with no droppedAt in loadKeys", async () => {
    db = await createTestDb();
    const ledger = new PgXArticleLedger(db);
    await ledger.add({ itemId: "x:1", postId: "111", sentAt: "2026-07-28T00:00:00Z" });
    expect((await ledger.loadKeys()).has("x:1")).toBe(true);
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const ledger = new PgXArticleLedger(localDb);
    await ledger.add({ itemId: "x:1", postId: "1", sentAt: "2026-07-28T00:00:00Z" });
    await ledger.add({ itemId: "x:2", postId: "2", sentAt: "2026-07-28T00:00:01Z" });
    await ledger.add({ itemId: "x:3", postId: "3", sentAt: "2026-07-28T00:00:02Z" });

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from x_article_deliveries where item_id = $1",
      ["x:1"],
    );

    // Update the first-inserted row last — if `add` ever touched `ordinal`, this would move x:1 to
    // the end of loadAll() and bump its ordinal value.
    await ledger.add({ itemId: "x:1", postId: "1", url: "https://x.com/i/article/1", sentAt: "2026-07-28T00:00:00Z" });

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from x_article_deliveries where item_id = $1",
      ["x:1"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await ledger.loadAll();
    expect(all.map((e) => e.itemId)).toEqual(["x:1", "x:2", "x:3"]);
    expect(all[0]?.url).toBe("https://x.com/i/article/1");
  });
});
