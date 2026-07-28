import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonXArticleLedger } from "../../../src/adapters/store/JsonXArticleLedger";

describe("JsonXArticleLedger", () => {
  it("records a posted itemId and reports it, upserting by itemId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xaled-"));
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
});
