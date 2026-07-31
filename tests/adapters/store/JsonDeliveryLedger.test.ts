import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonDeliveryLedger } from "../../../src/adapters/store/JsonDeliveryLedger";
import { deliveryKey } from "../../../src/domain/delivery/models";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deliveries-"));
});

const sent = { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };

describe("JsonDeliveryLedger", () => {
  it("round-trips an entry", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    expect(await l.loadAll()).toEqual([sent]);
    expect([...(await l.loadKeys())]).toEqual(["x:1:announcement:tg-community"]);
  });

  it("keeps two rooms on one channel apart — THE bug this re-keying exists to prevent", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    const keys = await l.loadKeys();
    expect(keys.has(deliveryKey({ itemId: "x:1", type: "announcement", outletId: "tg-community" }))).toBe(true);
    expect(keys.has(deliveryKey({ itemId: "x:1", type: "announcement", outletId: "tg-dev" }))).toBe(false);
  });

  it("upserts on the same key rather than appending", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    await l.add({ ...sent, url: "https://t.me/c/1/2" });
    const all = await l.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  it("removes an entry by key (used to untick 전달함)", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add({ ...sent, status: "delivered", by: "manual" });
    await l.remove(deliveryKey(sent));
    expect(await l.loadAll()).toEqual([]);
  });

  // REGRESSION: `replace()` deletes `previous`'s key then sets `next`'s key on the same Map — an
  // unconditional delete-then-set moves the row to the end of Map iteration order even when the two
  // keys are equal, which is sendToOutlet.ts's actual resend shape (`restore` never changes the
  // key). `loadAll()`'s array order is this Map's iteration order, and PgDeliveryLedger's `ordinal`
  // depends on the same insertion-order invariant, so both adapters must agree on it.
  it("a same-key replace() keeps the row's position, matching a plain add()'s upsert", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    await l.add({ ...sent, outletId: "tg-dev" });
    await l.add({ ...sent, outletId: "tg-defi" });

    await l.replace(sent, { ...sent, url: "https://t.me/c/1/2" });

    const all = await l.loadAll();
    expect(all.map((e) => e.outletId)).toEqual(["tg-community", "tg-dev", "tg-defi"]);
    expect(all[0]?.url).toBe("https://t.me/c/1/2");
  });

  /**
   * Residual race, accepted rather than fixed. `add()` is a plain read-modify-write: two overlapping
   * calls on the SAME instance both read the same file, and the second `rename` silently discards
   * the first one's row — this store no longer wraps that in an in-process queue or a cross-process
   * file lock (see `PgDeliveryLedger` for the store that protects concurrent writers with a database
   * transaction instead). Firing both without awaiting the first is what reproduces the overlap; a
   * sequential `await` each never races and is exactly what `db:export` does, this store's only
   * caller once Task 17 moves the live send path onto `PgDeliveryLedger` — see
   * `src/adapters/store/JsonDeliveryLedger.ts` for why that makes this an accepted gap rather than a
   * bug to chase here.
   */
  it("can lose one write of two overlapping add() calls — accepted for a single-process caller", async () => {
    const l = new JsonDeliveryLedger(dir);
    const a = { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent" as const, at: "2026-07-29T00:00:00.000Z", by: "auto" as const };
    const b = { itemId: "x:2", type: "announcement", outletId: "tg-dev", status: "sent" as const, at: "2026-07-29T00:00:01.000Z", by: "auto" as const };
    await Promise.all([l.add(a), l.add(b)]);
    const keys = await l.loadKeys();
    // At least one of the two survives; asserting neither does not depend on which one won the race.
    expect(keys.has(deliveryKey(a)) || keys.has(deliveryKey(b))).toBe(true);
  });

  it("migrates a legacy channel-keyed ledger to the channel's primary outlet", async () => {
    await writeFile(
      join(dir, "channels.json"),
      JSON.stringify([
        { itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram-bot", sentAt: "2026-07-01T00:00:00.000Z", url: "u" },
        { itemId: "x:2", type: "x", channel: "x", senderName: "typefully", sentAt: "2026-07-02T00:00:00.000Z", postId: "p" },
      ]),
      "utf8",
    );
    const all = await new JsonDeliveryLedger(dir).loadAll();
    expect(all.map((e) => [e.itemId, e.outletId, e.status, e.by])).toEqual([
      ["x:1", "tg-community", "sent", "auto"],
      ["x:2", "x-post", "sent", "auto"],
    ]);
    expect(all[0]?.at).toBe("2026-07-01T00:00:00.000Z");
    expect(all[0]?.url).toBe("u");
  });

  it("persists a migrated legacy row into deliveries.json once any entry is added, and never touches channels.json", async () => {
    const legacyRaw = JSON.stringify([{ itemId: "x:9", type: "x", channel: "x", senderName: "s", sentAt: "2026-07-01T00:00:00.000Z" }]);
    await writeFile(join(dir, "channels.json"), legacyRaw, "utf8");
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    // The pre-existing legacy row (x:9) must survive the unrelated add() — it is a real past send,
    // not a value to be dropped just because deliveries.json now exists.
    expect((await l.loadAll()).map((e) => e.itemId).sort()).toEqual(["x:1", "x:9"]);
    expect(JSON.parse(await readFile(join(dir, "deliveries.json"), "utf8"))).toHaveLength(2);
    // Read-only migration: the legacy file itself is never rewritten or deleted.
    expect(await readFile(join(dir, "channels.json"), "utf8")).toBe(legacyRaw);
  });

  it("keeps a legacy sent item visible in loadKeys() after an unrelated add() — the live-resend regression", async () => {
    await writeFile(
      join(dir, "channels.json"),
      JSON.stringify([{ itemId: "x:100", type: "announcement", channel: "telegram", senderName: "telegram-bot", sentAt: "2026-07-01T00:00:00.000Z" }]),
      "utf8",
    );
    const l = new JsonDeliveryLedger(dir);
    const legacyKey = deliveryKey({ itemId: "x:100", type: "announcement", outletId: "tg-community" });
    expect((await l.loadKeys()).has(legacyKey)).toBe(true);

    await l.add({ itemId: "x:200", type: "announcement", outletId: "tg-dev", status: "sent", at: "2026-07-29T00:00:00.000Z", by: "auto" });

    // If this flips to false, an already-sent item became indistinguishable from never-sent, and
    // SendChannels.run() would re-post it live on the next send:channels run.
    expect((await l.loadKeys()).has(legacyKey)).toBe(true);
  });
});

/**
 * A `dropped` row records a scheduled X send whose Typefully draft was deleted before it published —
 * nothing ever reached the room. `loadKeys()` is what `SendChannels.run()` gates re-sending on, so a
 * dropped row must stop counting as "already delivered" there, while `loadAll()` — what the board
 * reads — keeps it, so the operator can still see what happened to it.
 */
describe("JsonDeliveryLedger.loadKeys — dropped rows", () => {
  it("omits a dropped row so the room can be sent to again", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add({ ...sent, status: "dropped" });
    expect(await l.loadKeys()).toEqual(new Set());
    // The row itself is still there — the board explains what happened.
    expect(await l.loadAll()).toHaveLength(1);
  });

  it("keeps sent and delivered rows in the key set", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    await l.add({ ...sent, outletId: "tg-dev", status: "delivered" });
    expect(await l.loadKeys()).toEqual(
      new Set([deliveryKey(sent), deliveryKey({ ...sent, outletId: "tg-dev" })]),
    );
  });

  it("replaces a dropped row when the room is sent to again", async () => {
    const l = new JsonDeliveryLedger(dir);
    await l.add({ ...sent, status: "dropped" });
    await l.add({ ...sent, status: "sent", postId: "99" });
    const all = await l.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "sent", postId: "99" });
  });
});
