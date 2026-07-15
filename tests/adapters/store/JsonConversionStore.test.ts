import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonConversionStore } from "../../../src/adapters/store/JsonConversionStore";
import type { ContentVariant } from "../../../src/domain/conversion/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피",
    status: "converted", createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "conv-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonConversionStore", () => {
  it("returns [] when the file is missing", async () => {
    expect(await new JsonConversionStore(dir).loadAll()).toEqual([]);
  });

  it("upserts by (itemId, type): same key replaces, different type coexists", async () => {
    const store = new JsonConversionStore(dir);
    await store.upsert(variant({ convertedText: "v1" }));
    await store.upsert(variant({ convertedText: "v2" }));          // same (x:1, x) → replace
    await store.upsert(variant({ type: "kol", convertedText: "k" })); // (x:1, kol) → new
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((v) => v.type === "x")?.convertedText).toBe("v2");
    expect(all.find((v) => v.type === "kol")?.convertedText).toBe("k");
  });

  it("listConvertedKeys returns `${itemId}:${type}` keys", async () => {
    const store = new JsonConversionStore(dir);
    await store.upsert(variant());
    await store.upsert(variant({ itemId: "x:2", type: "pr" }));
    expect(await store.listConvertedKeys()).toEqual(new Set(["x:1:x", "x:2:pr"]));
  });
});
