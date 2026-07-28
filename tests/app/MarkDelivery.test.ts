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
});
