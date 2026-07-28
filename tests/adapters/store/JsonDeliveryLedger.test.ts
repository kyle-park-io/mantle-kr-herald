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

  it("prefers deliveries.json and ignores the legacy file once it exists", async () => {
    await writeFile(join(dir, "channels.json"), JSON.stringify([{ itemId: "x:9", type: "x", channel: "x", senderName: "s", sentAt: "2026-07-01T00:00:00.000Z" }]), "utf8");
    const l = new JsonDeliveryLedger(dir);
    await l.add(sent);
    expect((await l.loadAll()).map((e) => e.itemId)).toEqual(["x:1"]);
    expect(JSON.parse(await readFile(join(dir, "deliveries.json"), "utf8"))).toHaveLength(1);
  });
});
