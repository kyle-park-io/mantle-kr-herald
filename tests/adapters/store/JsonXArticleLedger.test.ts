import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { JsonXArticleLedger } from "../../../src/adapters/store/JsonXArticleLedger";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "x-article-"));
});

describe("JsonXArticleLedger", () => {
  it("records a posted itemId and reports it, upserting by itemId", async () => {
    const ledger = new JsonXArticleLedger(dir);
    expect(await ledger.loadKeys()).toEqual(new Set());

    await ledger.add({ itemId: "x:1", postId: "111", url: "https://x.com/i/article/111", sentAt: "2026-07-28T00:00:00Z" });
    await ledger.add({ itemId: "x:1", postId: "222", sentAt: "2026-07-28T01:00:00Z" }); // same id → upsert, not a second row
    const keys = await ledger.loadKeys();
    expect(keys.has("x:1")).toBe(true);
    expect(keys.size).toBe(1);

    await ledger.add({ itemId: "x:2", sentAt: "2026-07-28T02:00:00Z" });
    expect((await ledger.loadKeys()).size).toBe(2);
  });

  /**
   * Residual race, accepted rather than fixed — see `JsonDeliveryLedger`'s equivalent test for the
   * full reasoning. `add()` is a plain read-modify-write with no in-process queue or cross-process
   * file lock around it any more; this store's only caller once Task 17 lands is `db:export`, a
   * single sequential process that never overlaps its own writes.
   */
  it("can lose one row of two overlapping adds — accepted for a single-process caller", async () => {
    const ledger = new JsonXArticleLedger(dir);
    await Promise.all([
      ledger.add({ itemId: "x:1", postId: "1", sentAt: "2026-07-29T00:00:00Z" }),
      ledger.add({ itemId: "x:2", postId: "2", sentAt: "2026-07-29T00:00:01Z" }),
    ]);
    const ids = new Set((await ledger.loadAll()).map((e) => e.itemId));
    // At least one of the two survives; asserting neither does not depend on which one won the race.
    expect(ids.has("x:1") || ids.has("x:2")).toBe(true);
  });

  /**
   * `droppedAt` marks a row whose Typefully draft was deleted before it published — nothing reached
   * the room. `loadKeys()` gates `SendXArticle.run()`'s re-send check, so a dropped row must stop
   * counting there, while `loadAll()` keeps it so the board can still explain what happened to it.
   */
  it("omits a row with droppedAt from loadKeys, but keeps it in loadAll", async () => {
    const ledger = new JsonXArticleLedger(dir);
    await ledger.add({ itemId: "x:1", postId: "111", sentAt: "2026-07-28T00:00:00Z", droppedAt: "2026-07-29T00:00:00Z" });
    expect(await ledger.loadKeys()).toEqual(new Set());
    expect(await ledger.loadAll()).toHaveLength(1);
  });

  it("keeps a row with no droppedAt in loadKeys", async () => {
    const ledger = new JsonXArticleLedger(dir);
    await ledger.add({ itemId: "x:1", postId: "111", sentAt: "2026-07-28T00:00:00Z" });
    expect((await ledger.loadKeys()).has("x:1")).toBe(true);
  });
});
