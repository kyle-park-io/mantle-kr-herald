import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFormattingStore } from "../../../src/adapters/store/JsonFormattingStore";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "t", refined: false, createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "fmt-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("JsonFormattingStore", () => {
  it("upserts by (itemId, type, channel)", async () => {
    const store = new JsonFormattingStore(dir);
    await store.upsert(rendering({ text: "v1" }));
    await store.upsert(rendering({ text: "v2" }));                       // replace
    await store.upsert(rendering({ channel: "kakao", text: "k" }));      // new channel
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.channel === "x")?.text).toBe("v2");
  });

  it("listRenderedKeys returns `${itemId}:${type}:${channel}`", async () => {
    const store = new JsonFormattingStore(dir);
    await store.upsert(rendering());
    await store.upsert(rendering({ type: "kol", channel: "telegram" }));
    expect(await store.listRenderedKeys()).toEqual(new Set(["x:1:x:x", "x:1:kol:telegram"]));
  });
});
