import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgPublishStore } from "../../../src/adapters/store/PgPublishStore";
import { entryKey, type SyncEntry } from "../../../src/domain/publish/syncLedger";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

function entry(over: Partial<SyncEntry> = {}): SyncEntry {
  return { itemId: "x:1", stage: "translation", status: "translated", target: "google", ...over };
}

describe("PgPublishStore", () => {
  it("listEntries is empty initially, then reflects recorded entries", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    expect(await store.listEntries()).toHaveLength(0);
    await store.record(entry({ target: "google" }));
    await store.record(entry({ target: "lark" }));
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toContain("x:1:translated:google");
    expect(keys).toContain("x:1:translated:lark");
    expect(keys).toHaveLength(2);
  });

  it("record is idempotent for the same key", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await store.record(entry());
    await store.record(entry());
    expect(await store.listEntries()).toHaveLength(1);
  });

  it("upserts by (itemId, status, target) so a re-upload replaces the old row", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "a", contentHash: "sha256:aa", uploadedAt: "2026-07-20T00:00:00.000Z" });
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google", remoteId: "b", contentHash: "sha256:bb", uploadedAt: "2026-07-21T00:00:00.000Z" });
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "lark", remoteId: "c" });

    const entries = await store.listEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.target === "google")?.remoteId).toBe("b");
    expect(entries.find((e) => e.target === "lark")?.remoteId).toBe("c");
  });

  it("remove drops the entry with the given key and keeps the rest", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    const a: SyncEntry = { itemId: "x:1", stage: "translation", status: "translated", target: "google", fileName: "a.md", remoteId: "ra", contentHash: "h", uploadedAt: "t" };
    const b: SyncEntry = { ...a, status: "approved", fileName: "b.md", remoteId: "rb" };
    await store.record(a);
    await store.record(b);
    await store.remove(entryKey(a));
    const keys = (await store.listEntries()).map(entryKey);
    expect(keys).toEqual(["x:1:approved:google"]);
  });

  it("remove parses an itemId that itself contains a colon the same way entryKey joins it", async () => {
    // itemId is "x:1934" — the joined key "x:1934:approved:google" has itemId spanning the first
    // two colon-separated segments. A naive split(":") that assumes a fixed segment count could
    // misassign the parts; recomputing the join in SQL and comparing it whole is immune to that.
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await store.record(entry({ itemId: "x:1934", status: "approved", target: "google" }));
    await store.record(entry({ itemId: "lark:2", status: "approved", target: "google" }));
    await store.remove(entryKey({ itemId: "x:1934", status: "approved", target: "google" }));
    const all = await store.listEntries();
    expect(all).toHaveLength(1);
    expect(all[0]?.itemId).toBe("lark:2");
  });

  it("remove of a key with no matching row is a no-op", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await store.record(entry());
    await store.remove(entryKey(entry({ target: "nope" })));
    expect(await store.listEntries()).toHaveLength(1);
  });

  it("omits absent optional fields rather than returning null", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await store.record(entry());
    const [row] = await store.listEntries();
    expect(row).not.toHaveProperty("remoteId", null);
    expect(row?.remoteId).toBeUndefined();
    expect(row?.fileName).toBeUndefined();
    expect(row?.url).toBeUndefined();
    expect(row?.contentHash).toBeUndefined();
    expect(row?.uploadedAt).toBeUndefined();
  });

  it("survives two overlapping records of different rows — no read-modify-write left to lose one", async () => {
    db = await createTestDb();
    const store = new PgPublishStore(db);
    await Promise.all([
      store.record(entry({ target: "google" })),
      store.record(entry({ target: "lark" })),
    ]);
    const keys = (await store.listEntries()).map(entryKey).sort();
    expect(keys).toEqual(["x:1:translated:google", "x:1:translated:lark"].sort());
  });

  it("update leaves ordinal untouched, so listEntries() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const store = new PgPublishStore(localDb);
    await store.record(entry({ target: "a" }));
    await store.record(entry({ target: "b" }));
    await store.record(entry({ target: "c" }));

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from publish_entries where item_id = $1 and status = $2 and target = $3",
      ["x:1", "translated", "a"],
    );

    // Re-record the first-inserted row last — if `record` ever touched `ordinal`, this would move
    // target "a" to the end of listEntries() and bump its ordinal value.
    await store.record(entry({ target: "a", remoteId: "changed" }));

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from publish_entries where item_id = $1 and status = $2 and target = $3",
      ["x:1", "translated", "a"],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await store.listEntries();
    expect(all.map((e) => e.target)).toEqual(["a", "b", "c"]);
    expect(all[0]?.remoteId).toBe("changed");
  });
});
