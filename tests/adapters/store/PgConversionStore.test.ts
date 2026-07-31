import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgConversionStore } from "../../../src/adapters/store/PgConversionStore";
import type { ContentVariant } from "../../../src/domain/conversion/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return {
    itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피",
    status: "converted", createdAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("PgConversionStore", () => {
  it("returns [] when no rows are stored", async () => {
    db = await createTestDb();
    const store = new PgConversionStore(db);
    expect(await store.loadAll()).toEqual([]);
  });

  it("upserts by (itemId, type): same key replaces, different type coexists", async () => {
    db = await createTestDb();
    const store = new PgConversionStore(db);
    await store.upsert(variant({ convertedText: "v1" }));
    await store.upsert(variant({ convertedText: "v2" }));              // same (x:1, x) → replace
    await store.upsert(variant({ type: "kol", convertedText: "k" }));  // (x:1, kol) → new
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((v) => v.type === "x")?.convertedText).toBe("v2");
    expect(all.find((v) => v.type === "kol")?.convertedText).toBe("k");
  });

  it("listConvertedKeys returns `${itemId}:${type}` keys", async () => {
    db = await createTestDb();
    const store = new PgConversionStore(db);
    await store.upsert(variant());
    await store.upsert(variant({ itemId: "x:2", type: "pr" }));
    expect(await store.listConvertedKeys()).toEqual(new Set(["x:1:x", "x:2:pr"]));
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgConversionStore(db);
    await store.upsert(variant());
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("approvedAt", null);
    expect(row?.approvedAt).toBeUndefined();
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgConversionStore(db);
    await Promise.all([
      store.upsert(variant({ itemId: "x:1" })),
      store.upsert(variant({ itemId: "x:2" })),
    ]);
    expect(await store.listConvertedKeys()).toEqual(new Set(["x:1:x", "x:2:x"]));
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgConversionStore(localDb);
    await store.upsert(variant({ itemId: "x:1" }));
    await store.upsert(variant({ itemId: "x:2" }));
    await store.upsert(variant({ itemId: "x:3" }));

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from variants where item_id = $1 and type = $2",
      ["x:1", "x"],
    );

    // Update the first-inserted row last — if `upsert` ever touched `ordinal`, this would move
    // x:1 to the end of loadAll() and bump its ordinal value.
    await store.upsert(variant({ itemId: "x:1", convertedText: "고침", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from variants where item_id = $1 and type = $2",
      ["x:1", "x"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((v) => v.itemId)).toEqual(["x:1", "x:2", "x:3"]);
    expect(all[0]?.convertedText).toBe("고침");
  });
});
