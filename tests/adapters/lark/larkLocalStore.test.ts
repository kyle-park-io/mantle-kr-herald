import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkLocalStore } from "../../../src/adapters/lark/LarkLocalStore";
import type { LarkMessage } from "../../../src/domain/larkMessage";

function msg(id: string, over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: id,
    chatId: over.chatId ?? "oc_x",
    msgType: "text",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    text: over.text ?? `t${id}`,
    rawContent: `{"text":"t${id}"}`,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lark-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LarkLocalStore", () => {
  it("upsert then loadAll round-trips", async () => {
    const store = new LarkLocalStore(dir);
    await store.upsert([msg("om_1")]);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("upsert merges by messageId (incoming wins) without dropping stored messages", async () => {
    const store = new LarkLocalStore(dir);
    await store.upsert([msg("om_1", { text: "old" }), msg("om_2")]);
    await store.upsert([msg("om_1", { text: "new" })]); // subset re-collect
    const all = await store.loadAll();
    expect(all.map((m) => m.messageId).sort()).toEqual(["om_1", "om_2"]);
    expect(all.find((m) => m.messageId === "om_1")?.text).toBe("new");
  });

  it("per-chat watermark get/set is isolated by key", async () => {
    const store = new LarkLocalStore(dir);
    expect(await store.get("oc_a")).toBeUndefined();
    await store.set("oc_a", "2026-02-02T00:00:00.000Z");
    await store.set("oc_b", "2026-03-03T00:00:00.000Z");
    expect(await store.get("oc_a")).toBe("2026-02-02T00:00:00.000Z");
    expect(await store.get("oc_b")).toBe("2026-03-03T00:00:00.000Z");
  });
});
