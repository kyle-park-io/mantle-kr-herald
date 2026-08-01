import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgFewShotStore, fewShotStoresByType } from "../../../src/adapters/store/PgFewShotStore";
import { ALL_TYPES } from "../../../src/domain/conversion/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

describe("PgFewShotStore", () => {
  it("returns [] when no rows are stored", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    expect(await store.load()).toEqual([]);
  });

  it("add appends; load returns all", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가" });
    await store.add({ source: "b", target: "나" });
    expect(await store.load()).toHaveLength(2);
  });

  it("add upserts by itemId when present, keeping the latest target", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가", itemId: "x:1" });
    await store.add({ source: "a-fixed", target: "가고침", itemId: "x:1" });
    const all = await store.load();
    expect(all).toHaveLength(1);
    expect(all[0]?.target).toBe("가고침");
  });

  it("two itemId-less examples in the same scope coexist rather than colliding", async () => {
    // The port's contract is "upserts by itemId when present, otherwise appends" — an append must
    // never silently become an overwrite. `few_shot_examples` relies on Postgres treating every
    // null item_id as distinct within `unique (scope, item_id)`; this proves that behaviour rather
    // than assuming it, since "append" quietly becoming "overwrite" would destroy the corpus.
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가" });
    await store.add({ source: "b", target: "나" });
    await store.add({ source: "c", target: "다" });
    const all = await store.load();
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.target)).toEqual(["가", "나", "다"]);
    expect(all.map((e) => e.itemId)).toEqual([undefined, undefined, undefined]);
  });

  it("omits itemId when absent rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가" });
    const [row] = await store.load();
    expect(row).not.toHaveProperty("itemId", null);
    expect(row?.itemId).toBeUndefined();
  });

  it("two different scopes never collide, even with the same itemId", async () => {
    db = await createTestDb();
    const translationScope = new PgFewShotStore(db, "translation");
    const conversionScope = new PgFewShotStore(db, "conversion:announcement");
    await translationScope.add({ source: "en", target: "ko", itemId: "x:1" });
    await conversionScope.add({ source: "ko", target: "announcement copy", itemId: "x:1" });

    expect(await translationScope.load()).toEqual([{ source: "en", target: "ko", itemId: "x:1" }]);
    expect(await conversionScope.load()).toEqual([{ source: "ko", target: "announcement copy", itemId: "x:1" }]);
  });

  it("survives two overlapping adds of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await Promise.all([
      store.add({ source: "a", target: "가", itemId: "x:1" }),
      store.add({ source: "b", target: "나", itemId: "x:2" }),
    ]);
    const all = await store.load();
    expect(all.map((e) => e.itemId).sort()).toEqual(["x:1", "x:2"]);
  });

  it("update leaves ordinal untouched, so load() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgFewShotStore(localDb, "translation");
    await store.add({ source: "a", target: "가", itemId: "x:1" });
    await store.add({ source: "b", target: "나", itemId: "x:2" });
    await store.add({ source: "c", target: "다", itemId: "x:3" });

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from few_shot_examples where scope = $1 and item_id = $2",
      ["translation", "x:1"],
    );

    // Update the first-inserted row last — if `add` ever touched `ordinal`, this would move x:1
    // to the end of load() and bump its ordinal value.
    await store.add({ source: "a-fixed", target: "가고침", itemId: "x:1" });

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from few_shot_examples where scope = $1 and item_id = $2",
      ["translation", "x:1"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.load();
    expect(all.map((e) => e.itemId)).toEqual(["x:1", "x:2", "x:3"]);
    expect(all[0]?.target).toBe("가고침");
  });
});

describe("fewShotStoresByType", () => {
  it("builds one store per conversion type, each in its own scope", async () => {
    db = await createTestDb();
    const byType = fewShotStoresByType(db);
    expect(Object.keys(byType).sort()).toEqual([...ALL_TYPES].sort());

    await byType.announcement.add({ source: "ko", target: "공지" });
    await byType.casual.add({ source: "ko", target: "캐주얼" });

    expect(await byType.announcement.load()).toEqual([{ source: "ko", target: "공지" }]);
    expect(await byType.casual.load()).toEqual([{ source: "ko", target: "캐주얼" }]);
  });
});
