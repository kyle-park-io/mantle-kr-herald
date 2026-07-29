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

  it("keeps both rows when two adds overlap", async () => {
    const ledger = new JsonXArticleLedger(dir);
    await Promise.all([
      ledger.add({ itemId: "x:1", postId: "1", sentAt: "2026-07-29T00:00:00Z" }),
      ledger.add({ itemId: "x:2", postId: "2", sentAt: "2026-07-29T00:00:01Z" }),
    ]);
    const ids = new Set((await ledger.loadAll()).map((e) => e.itemId));
    expect(ids.has("x:1")).toBe(true);
    expect(ids.has("x:2")).toBe(true);
  });
});
