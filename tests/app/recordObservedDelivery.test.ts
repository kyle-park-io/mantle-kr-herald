// tests/app/recordObservedDelivery.test.ts
import { describe, it, expect } from "vitest";
import { RecordObservedDelivery } from "../../src/app/RecordObservedDelivery";
import { deliveryKey, type DeliveryEntry } from "../../src/domain/delivery/models";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";

function fakeLedger(existing: string[] = []) {
  const added: DeliveryEntry[] = [];
  const keys = new Set(existing);
  const ledger: DeliveryLedger = {
    async loadAll() { return []; },
    async loadKeys() { return keys; },
    async add(e: DeliveryEntry) { added.push(e); keys.add(deliveryKey(e)); },
    async remove() {},
    async replace() {},
  } as unknown as DeliveryLedger;
  return { ledger, added };
}

const entry: DeliveryEntry = {
  itemId: "x:1",
  type: "x",
  outletId: "x-post",
  status: "sent",
  at: "2026-08-01T00:00:00.000Z",
  by: "manual",
  postId: "100",
  url: "https://x.com/0xMantleKR/status/100",
};

describe("RecordObservedDelivery", () => {
  it("writes an observation the ledger does not have", async () => {
    const { ledger, added } = fakeLedger();
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("written");
    expect(added).toEqual([entry]);
  });

  it("refuses to overwrite an existing row, and says so instead of throwing", async () => {
    // `sent` is never reversed, so the existing row is the record. Re-writing it could only change
    // a real send's post id to something a match guessed — and the caller needs to keep going
    // through the rest of the plan rather than abort on the first already-done row.
    const { ledger, added } = fakeLedger(["x:1:x:x-post"]);
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("already-recorded");
    expect(added).toEqual([]);
  });

  it("cannot be used to write anything but an observation", async () => {
    // The class exists so that observing X is the *only* way an auto outlet gains a row without a
    // bot having sent it. MarkDelivery still refuses a human's `delivered` claim on an auto outlet;
    // this must not become a back door for one.
    const { ledger } = fakeLedger();
    await expect(
      new RecordObservedDelivery(ledger).record({ ...entry, status: "delivered" }),
    ).rejects.toThrow(/observation/i);
  });

  it("requires the evidence that makes it an observation", async () => {
    // No post id means nothing was observed — it is a claim wearing an observation's status.
    const { ledger } = fakeLedger();
    await expect(new RecordObservedDelivery(ledger).record({ ...entry, postId: undefined })).rejects.toThrow(/postId/);
  });
});
