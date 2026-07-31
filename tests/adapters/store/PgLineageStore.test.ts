import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgLineageStore } from "../../../src/adapters/store/PgLineageStore";
import type { LineageEntry } from "../../../src/domain/lineage/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const entry = (over: Partial<LineageEntry> = {}): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "안녕", status: "translated", at: "2026-07-28T00:00:00.000Z", ...over,
});

describe("PgLineageStore", () => {
  it("appends and loads entries in order for an id containing ':'", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ content: "v1" }));
    await s.append(entry({ content: "v2" }));
    const got = await s.load("x:1");
    expect(got.map((e) => e.content)).toEqual(["v1", "v2"]);
  });

  it("returns [] for an item with no rows", async () => {
    db = await createTestDb();
    expect(await new PgLineageStore(db).load("x:404")).toEqual([]);
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append({ itemId: "x:1", stage: "translated", content: "안녕", at: "2026-07-28T00:00:00.000Z" });
    const [row] = await s.load("x:1");
    expect(row).not.toHaveProperty("variant", null);
    expect(row).not.toHaveProperty("status", null);
    expect(row).not.toHaveProperty("sourceText", null);
    expect(row?.variant).toBeUndefined();
    expect(row?.status).toBeUndefined();
    expect(row?.sourceText).toBeUndefined();
  });

  it("round-trips optional fields when present", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ variant: "announcement/telegram", sourceText: "Mantle news" }));
    const [row] = await s.load("x:1");
    expect(row?.variant).toBe("announcement/telegram");
    expect(row?.sourceText).toBe("Mantle news");
  });

  it("append is a plain insert — no uniqueness, so the same entry appended twice yields two rows", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry());
    await s.append(entry());
    const got = await s.load("x:1");
    expect(got).toHaveLength(2);
  });

  it("survives two overlapping appends of different items — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await Promise.all([
      s.append(entry({ itemId: "x:1", content: "a" })),
      s.append(entry({ itemId: "x:2", content: "b" })),
    ]);
    expect((await s.load("x:1")).map((e) => e.content)).toEqual(["a"]);
    expect((await s.load("x:2")).map((e) => e.content)).toEqual(["b"]);
  });

  it("listItems reports id, entry count, and last stage", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ stage: "translated" }));
    await s.append(entry({ stage: "converted", variant: "announcement" }));
    expect(await s.listItems()).toEqual([{ itemId: "x:1", entries: 2, lastStage: "converted" }]);
  });

  it("listItems' last stage is the last by `at`, not the last inserted", async () => {
    // Insert an entry with a *later* `at` first, then one with an *earlier* `at` — if listItems
    // picked "last inserted" instead of "last by at", it would report the wrong stage.
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ stage: "rendered", at: "2026-07-28T12:00:00.000Z" }));
    await s.append(entry({ stage: "converted", at: "2026-07-27T00:00:00.000Z" }));
    const [summary] = await s.listItems();
    expect(summary).toEqual({ itemId: "x:1", entries: 2, lastStage: "rendered" });
  });

  it("listItems groups by item_id across multiple items", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ itemId: "x:1", stage: "translated" }));
    await s.append(entry({ itemId: "lark:2", stage: "converted" }));
    await s.append(entry({ itemId: "x:1", stage: "rendered" }));
    const summaries = await s.listItems();
    expect(summaries.sort((a, b) => a.itemId.localeCompare(b.itemId))).toEqual(
      [
        { itemId: "lark:2", entries: 1, lastStage: "converted" },
        { itemId: "x:1", entries: 2, lastStage: "rendered" },
      ].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    );
  });

  it("listItems returns [] when no entries are stored", async () => {
    db = await createTestDb();
    expect(await new PgLineageStore(db).listItems()).toEqual([]);
  });
});
