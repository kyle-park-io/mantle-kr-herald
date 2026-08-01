import { describe, expect, it } from "vitest";
import { MarkDelivery } from "../../src/app/MarkDelivery";
import { deliveryKey, type DeliveryEntry } from "../../src/domain/delivery/models";

function fakeLedger(seed: DeliveryEntry[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    loadKeys: async () => new Set(rows.map(deliveryKey)),
    add: async (e: DeliveryEntry) => { rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(e)), e]; },
    remove: async (key: string) => { rows = rows.filter((r) => deliveryKey(r) !== key); },
    replace: async (previous: DeliveryEntry, next: DeliveryEntry) => {
      rows = [...rows.filter((r) => deliveryKey(r) !== deliveryKey(previous) && deliveryKey(r) !== deliveryKey(next)), next];
    },
    rows: () => rows,
  };
}
const args = { itemId: "x:1", type: "announcement", outletId: "kakao-kol" };

describe("MarkDelivery", () => {
  it("records a manual delivery", async () => {
    const l = fakeLedger();
    await new MarkDelivery(l, () => "2026-07-29T00:00:00.000Z").run({ ...args, delivered: true });
    expect(l.rows()).toEqual([{ ...args, status: "delivered", by: "manual", at: "2026-07-29T00:00:00.000Z" }]);
  });

  it("accepts PR 메일 — no mail sender exists, so a human sends it and ticks it", async () => {
    // As an `auto` room this was unreachable in both directions: send:channels cannot send
    // `pr_mail` at all, and MarkDelivery refused the tick precisely because it was `auto`.
    const l = fakeLedger();
    await new MarkDelivery(l, () => "T").run({ itemId: "x:1", type: "pr", outletId: "pr-mail", delivered: true });
    expect(l.rows()).toEqual([{ itemId: "x:1", type: "pr", outletId: "pr-mail", status: "delivered", by: "manual", at: "T" }]);
  });

  it("unticks a manual delivery", async () => {
    const l = fakeLedger([{ ...args, status: "delivered", by: "manual", at: "T" }]);
    await new MarkDelivery(l, () => "T2").run({ ...args, delivered: false });
    expect(l.rows()).toEqual([]);
  });

  it("refuses to untick an auto send — a sent post cannot be unsent", async () => {
    const l = fakeLedger([{ itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", by: "auto", at: "T" }]);
    const uc = new MarkDelivery(l, () => "T2");
    await expect(uc.run({ itemId: "x:1", type: "announcement", outletId: "tg-community", delivered: false })).rejects.toThrow(/sent/i);
    expect(l.rows()).toHaveLength(1);
  });

  it("rejects an unknown outlet", async () => {
    const l = fakeLedger();
    await expect(new MarkDelivery(l, () => "T").run({ ...args, outletId: "nope", delivered: true })).rejects.toThrow(/unknown outlet/i);
  });

  it("refuses to tick an auto outlet — it is delivered by send:channels, not marked manually", async () => {
    const l = fakeLedger();
    await expect(
      new MarkDelivery(l, () => "T").run({ itemId: "x:1", type: "announcement", outletId: "tg-community", delivered: true }),
    ).rejects.toThrow(/auto room/i);
    expect(l.rows()).toEqual([]);
  });

  it("allows unticking a delivered row on an auto outlet — repairs a bad row even though ticking one is refused", async () => {
    const l = fakeLedger([{ itemId: "x:1", type: "announcement", outletId: "tg-community", status: "delivered", by: "manual", at: "T" }]);
    await new MarkDelivery(l, () => "T2").run({ itemId: "x:1", type: "announcement", outletId: "tg-community", delivered: false });
    expect(l.rows()).toEqual([]);
  });
});
