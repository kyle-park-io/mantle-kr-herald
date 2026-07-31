import { describe, it, expect, afterEach } from "vitest";
import { createTestDb } from "../../support/testDb";
import { PgDeliveryLedger } from "../../../src/adapters/store/PgDeliveryLedger";
import { deliveryKey, type DeliveryEntry } from "../../../src/domain/delivery/models";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const sent: DeliveryEntry = {
  itemId: "x:1", type: "announcement", outletId: "tg-community",
  status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto",
};

describe("PgDeliveryLedger", () => {
  it("round-trips an entry", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(sent);
    expect(await ledger.loadAll()).toEqual([sent]);
    expect([...(await ledger.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  // Required by the task brief, verbatim. This only proves the upsert *outcome* — a store doing
  // select-then-insert in application code would pass it identically. The constraint itself, that
  // a second raw insert for the same (item_id, type, outlet_id) is rejected by Postgres rather than
  // merged, is proven directly in tests/adapters/db/schema.test.ts ("rejects a second delivery row
  // for the same (item, type, outlet)").
  it("refuses a duplicate (item, type, outlet) at the database, not in application code", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    const entry = { itemId: "x:1", type: "announcement", outletId: "tg-community",
                    status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };
    await ledger.add(entry);
    await ledger.add({ ...entry, url: "https://t.me/c/1/2" });
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  // Required by the task brief, verbatim.
  it("keeps two rooms on one channel apart — THE bug the re-keying exists to prevent", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add({ itemId: "x:1", type: "announcement", outletId: "tg-community",
                       status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" });
    const keys = await ledger.loadKeys();
    expect(keys.has("x:1:announcement:tg-community")).toBe(true);
    expect(keys.has("x:1:announcement:tg-dev")).toBe(false);
  });

  it("round-trips every optional field, including senderName — the Telegram sender identity the board shows", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    const full: DeliveryEntry = {
      ...sent, postId: "111", url: "https://t.me/c/1/2", senderName: "telegram-bot",
    };
    await ledger.add(full);
    const [row] = await ledger.loadAll();
    expect(row?.postId).toBe("111");
    expect(row?.url).toBe("https://t.me/c/1/2");
    expect(row?.senderName).toBe("telegram-bot");
  });

  it("upserts on the same key rather than appending", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(sent);
    await ledger.add({ ...sent, url: "https://t.me/c/1/2" });
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  it("removes an entry by key (used to untick 전달함)", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add({ ...sent, status: "delivered", by: "manual" });
    await ledger.remove(deliveryKey(sent));
    expect(await ledger.loadAll()).toEqual([]);
  });

  it("remove parses an itemId that itself contains a colon the same way deliveryKey joins it", async () => {
    // itemId is "x:1" (source:rootId) — the joined key is "x:1:announcement:tg-community", four
    // colon-separated pieces where the first two together are itemId. A naive split(":") that
    // assumes three parts would mis-parse this and delete (or fail to delete) the wrong row.
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(sent);
    await ledger.add({ ...sent, itemId: "lark:2" });
    await ledger.remove(deliveryKey(sent));
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.itemId).toBe("lark:2");
  });

  it("remove parses a type that itself contains a colon, matching deliveryKey whole", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add({ ...sent, type: "kol:special" });
    await ledger.add(sent);
    await ledger.remove(deliveryKey({ ...sent, type: "kol:special" }));
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("announcement");
  });

  it("remove of a key with no matching row is a no-op", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(sent);
    await ledger.remove(deliveryKey({ ...sent, outletId: "nope" }));
    expect(await ledger.loadAll()).toHaveLength(1);
  });

  it("survives two overlapping adds of different rows — the reconcile-vs-send race", async () => {
    // This cannot actually fail on PGlite: it's one connection, and `query()` calls are awaited in
    // turn under the hood, so `Promise.all` here serializes rather than truly overlapping — kept as
    // a regression marker for the failure mode `JsonDeliveryLedger`'s read-modify-write had (two
    // overlapping calls both reading the same file, the second rename silently discarding the
    // first row), not as a test capable of reproducing that race. What actually closes it is `add()`
    // being a single `insert ... on conflict` statement — proven structurally by there being no
    // `loadAll` + merge + rewrite in `add()`'s body, not by this test.
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    const a: DeliveryEntry = { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" };
    const b: DeliveryEntry = { itemId: "x:2", type: "announcement", outletId: "tg-dev", status: "sent", at: "2026-07-29T00:00:01.000Z", by: "auto" };
    await Promise.all([ledger.add(a), ledger.add(b)]);
    const keys = await ledger.loadKeys();
    expect(keys.has(deliveryKey(a))).toBe(true);
    expect(keys.has(deliveryKey(b))).toBe(true);
  });

  it("update leaves ordinal untouched, so loadAll() keeps insertion order after an edit", async () => {
    const localDb = await createTestDb();
    db = localDb;
    const ledger = new PgDeliveryLedger(localDb);
    await ledger.add(sent);
    await ledger.add({ ...sent, outletId: "tg-dev" });
    await ledger.add({ ...sent, outletId: "tg-defi" });

    const [{ ordinal: ordinalBefore }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from deliveries where item_id = $1 and type = $2 and outlet_id = $3",
      [sent.itemId, sent.type, sent.outletId],
    );

    // Update the first-inserted row last — if `add` ever touched `ordinal`, this would move the
    // tg-community row to the end of loadAll() and bump its ordinal value.
    await ledger.add({ ...sent, url: "https://t.me/c/1/2" });

    const [{ ordinal: ordinalAfter }] = await localDb.query<{ ordinal: string }>(
      "select ordinal from deliveries where item_id = $1 and type = $2 and outlet_id = $3",
      [sent.itemId, sent.type, sent.outletId],
    );
    expect(ordinalAfter).toBe(ordinalBefore);

    const all = await ledger.loadAll();
    expect(all.map((e) => e.outletId)).toEqual(["tg-community", "tg-dev", "tg-defi"]);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  /**
   * `JsonDeliveryLedger.loadAll()` fell back to `channels.json` when `deliveries.json` was absent,
   * and its doc comment warns that a migrated legacy row must keep appearing in `loadKeys()` after
   * any unrelated `add()` — an already-sent item silently becoming indistinguishable from never-sent
   * is a live resend. At the database there is only one table, and `db:import` writes a migrated
   * legacy row into it once, up front, as an ordinary row — this test stands in for that: a row
   * already present (simulating one `db:import` wrote) must survive an unrelated `add()` untouched.
   */
  it("a row already present in the table — standing in for one db:import migrated — survives an unrelated add()", async () => {
    db = await createTestDb();
    const legacy: DeliveryEntry = { itemId: "x:100", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-07-01T00:00:00.000Z", by: "auto" };
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(legacy); // stands in for a row db:import wrote directly into the table
    expect((await ledger.loadKeys()).has(deliveryKey(legacy))).toBe(true);

    await ledger.add({ itemId: "x:200", type: "announcement", outletId: "tg-dev", status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" });

    // If this flips to false, an already-sent item became indistinguishable from never-sent, and
    // SendChannels.run() would re-post it live on the next send:channels run.
    expect((await ledger.loadKeys()).has(deliveryKey(legacy))).toBe(true);
    expect((await ledger.loadAll()).map((e) => e.itemId).sort()).toEqual(["x:100", "x:200"]);
  });
});

describe("PgDeliveryLedger.loadKeys — dropped rows", () => {
  it("omits a dropped row so the room can be sent to again", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add({ ...sent, status: "dropped" });
    expect(await ledger.loadKeys()).toEqual(new Set());
    // The row itself is still there — the board explains what happened.
    expect(await ledger.loadAll()).toHaveLength(1);
  });

  it("keeps sent and delivered rows in the key set", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add(sent);
    await ledger.add({ ...sent, outletId: "tg-dev", status: "delivered" });
    expect(await ledger.loadKeys()).toEqual(
      new Set([deliveryKey(sent), deliveryKey({ ...sent, outletId: "tg-dev" })]),
    );
  });

  it("replaces a dropped row when the room is sent to again", async () => {
    db = await createTestDb();
    const ledger = new PgDeliveryLedger(db);
    await ledger.add({ ...sent, status: "dropped" });
    await ledger.add({ ...sent, status: "sent", postId: "99" });
    const all = await ledger.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "sent", postId: "99" });
  });
});
