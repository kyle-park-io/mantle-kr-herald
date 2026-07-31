import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgOutletOverrideStore } from "../../../src/adapters/store/PgOutletOverrideStore";
import { overrideKey, type OutletOverride } from "../../../src/domain/outlet/override";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function override(over: Partial<OutletOverride> = {}): OutletOverride {
  return {
    itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용",
    status: "rendered", createdAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("PgOutletOverrideStore", () => {
  it("returns [] when no rows are stored", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    expect(await store.loadAll()).toEqual([]);
  });

  it("upserts by (itemId, type, outletId): same key replaces, different outlet coexists", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ text: "v1" }));
    await store.upsert(override({ text: "v2" }));                          // same key → replace
    await store.upsert(override({ outletId: "tg-defi", text: "k" }));      // new outlet → coexists
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((o) => o.outletId === "tg-blockchain")?.text).toBe("v2");
    expect(all.find((o) => o.outletId === "tg-defi")?.text).toBe("k");
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override());
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("approvedAt", null);
    expect(row?.approvedAt).toBeUndefined();
  });

  it("round-trips an approved override with its approvedAt stamp", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));
    const [row] = await store.loadAll();
    expect(row?.status).toBe("approved");
    expect(row?.approvedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await Promise.all([
      store.upsert(override({ outletId: "tg-blockchain" })),
      store.upsert(override({ outletId: "tg-defi" })),
    ]);
    const keys = (await store.loadAll()).map(overrideKey).sort();
    expect(keys).toEqual(["x:1:announcement:tg-blockchain", "x:1:announcement:tg-defi"].sort());
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgOutletOverrideStore(localDb);
    await store.upsert(override({ outletId: "a" }));
    await store.upsert(override({ outletId: "b" }));
    await store.upsert(override({ outletId: "c" }));

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from outlet_overrides where item_id = $1 and type = $2 and outlet_id = $3",
      ["x:1", "announcement", "a"],
    );

    // Update the first-inserted row last — if `upsert` ever touched `ordinal`, this would move
    // outlet "a" to the end of loadAll() and bump its ordinal value.
    await store.upsert(override({ outletId: "a", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from outlet_overrides where item_id = $1 and type = $2 and outlet_id = $3",
      ["x:1", "announcement", "a"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((o) => o.outletId)).toEqual(["a", "b", "c"]);
    expect(all[0]?.status).toBe("approved");
  });

  it("remove deletes the row matching the joined key, leaving the others", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ outletId: "a" }));
    await store.upsert(override({ outletId: "b" }));
    await store.remove(overrideKey({ itemId: "x:1", type: "announcement", outletId: "a" }));
    const all = await store.loadAll();
    expect(all.map((o) => o.outletId)).toEqual(["b"]);
  });

  it("remove parses an itemId that itself contains a colon the same way overrideKey joins it", async () => {
    // itemId is "x:1" (source:rootId) — the joined key is "x:1:announcement:a", four colon-
    // separated pieces where the first two together are itemId. A naive split(":") that assumes
    // three parts would mis-parse this and delete (or fail to delete) the wrong row.
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ itemId: "x:1", outletId: "a" }));
    await store.upsert(override({ itemId: "lark:2", outletId: "a" }));
    await store.remove(overrideKey({ itemId: "x:1", type: "announcement", outletId: "a" }));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.itemId).toBe("lark:2");
  });

  it("remove parses a type that itself contains a colon, matching overrideKey whole", async () => {
    // Nothing on this write path validates `type` against ALL_TYPES (apiHandlers.ts takes it
    // straight off the URL segment), so a colon in `type` is reachable at runtime even though the
    // frontend never sends one. A right-anchored split(":") that assumes the last two segments
    // are always outletId/type would misassign this key's parts; recomputing the key in SQL and
    // comparing it whole — like JsonOutletOverrideStore does — is immune to a colon in any field.
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ type: "kol:special", outletId: "a" }));
    await store.upsert(override({ type: "announcement", outletId: "a" }));
    await store.remove(overrideKey({ itemId: "x:1", type: "kol:special", outletId: "a" }));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("announcement");
  });

  it("remove of a key with no matching row is a no-op", async () => {
    db = await createTestDb();
    const store = new PgOutletOverrideStore(db);
    await store.upsert(override({ outletId: "a" }));
    await store.remove(overrideKey({ itemId: "x:1", type: "announcement", outletId: "nope" }));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
  });
});
