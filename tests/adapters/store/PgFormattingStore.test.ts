import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgFormattingStore } from "../../../src/adapters/store/PgFormattingStore";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return {
    itemId: "x:1", type: "x", channel: "x", text: "t", refined: false,
    createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over,
  };
}

describe("PgFormattingStore", () => {
  it("returns [] when no rows are stored", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    expect(await store.loadAll()).toEqual([]);
  });

  it("upserts by (itemId, type, channel)", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    await store.upsert(rendering({ text: "v1" }));
    await store.upsert(rendering({ text: "v2" }));                   // replace
    await store.upsert(rendering({ channel: "kakao", text: "k" }));  // new channel
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.channel === "x")?.text).toBe("v2");
  });

  it("listRenderedKeys returns `${itemId}:${type}:${channel}`", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    await store.upsert(rendering());
    await store.upsert(rendering({ type: "kol", channel: "telegram" }));
    expect(await store.listRenderedKeys()).toEqual(new Set(["x:1:x:x", "x:1:kol:telegram"]));
  });

  it("round-trips refined as a boolean and status distinguishing rendered from approved", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    await store.upsert(rendering({ refined: true, status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));
    const [row] = await store.loadAll();
    expect(row?.refined).toBe(true);
    expect(row?.status).toBe("approved");
    expect(row?.approvedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    await store.upsert(rendering());
    const [row] = await store.loadAll();
    expect(row).not.toHaveProperty("approvedAt", null);
    expect(row?.approvedAt).toBeUndefined();
  });

  it("survives two overlapping upserts of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgFormattingStore(db);
    await Promise.all([
      store.upsert(rendering({ itemId: "x:1" })),
      store.upsert(rendering({ itemId: "x:2" })),
    ]);
    expect(await store.listRenderedKeys()).toEqual(new Set(["x:1:x:x", "x:2:x:x"]));
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgFormattingStore(localDb);
    await store.upsert(rendering({ itemId: "x:1" }));
    await store.upsert(rendering({ itemId: "x:2" }));
    await store.upsert(rendering({ itemId: "x:3" }));

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from renderings where item_id = $1 and type = $2 and channel = $3",
      ["x:1", "x", "x"],
    );

    // Update the first-inserted row last — if `upsert` ever touched `ordinal`, this would move
    // x:1 to the end of loadAll() and bump its ordinal value.
    await store.upsert(rendering({ itemId: "x:1", refined: true, status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" }));

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from renderings where item_id = $1 and type = $2 and channel = $3",
      ["x:1", "x", "x"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.loadAll();
    expect(all.map((r) => r.itemId)).toEqual(["x:1", "x:2", "x:3"]);
    expect(all[0]?.status).toBe("approved");
  });
});
