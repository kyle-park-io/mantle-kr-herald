// tests/app/recordObservedDelivery.test.ts
import { describe, it, expect } from "vitest";
import { RecordObservedDelivery } from "../../src/app/RecordObservedDelivery";
import { deliveredToRoom, deliveryKey, type DeliveryEntry } from "../../src/domain/delivery/models";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";

/**
 * Backed by rows, with `loadKeys()` derived through `deliveredToRoom` exactly as
 * `PgDeliveryLedger.loadKeys()` and `JsonDeliveryLedger.loadKeys()` derive theirs, and `add()` as an
 * upsert on `deliveryKey` — the real store's `insert … on conflict … do update`.
 *
 * It used to take a bare list of key strings and have `loadKeys()` return them unfiltered, which is
 * why the `dropped`-row case below was invisible to this file: the real `loadKeys()` drops such a row,
 * so the guard did not see it, and the real `add()` then overwrote it and reported `✓ recorded`. A
 * fake that answers "already delivered?" differently from every real store cannot test a class whose
 * whole job is that question.
 */
function fakeLedger(existing: DeliveryEntry[] = []) {
  const added: DeliveryEntry[] = [];
  const rows = [...existing];
  const ledger: DeliveryLedger = {
    async loadAll() { return [...rows]; },
    async loadKeys() { return new Set(rows.filter(deliveredToRoom).map(deliveryKey)); },
    async add(e: DeliveryEntry) {
      added.push(e);
      const at = rows.findIndex((r) => deliveryKey(r) === deliveryKey(e));
      if (at >= 0) rows[at] = e;
      else rows.push(e);
    },
    async remove() {},
    async replace() {},
  } as unknown as DeliveryLedger;
  return { ledger, added, rows };
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
    const { ledger, added } = fakeLedger([{ ...entry, postId: "77", url: "https://x.com/bcd_kyle/status/77" }]);
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("already-recorded");
    expect(added).toEqual([]);
  });

  it("also refuses to overwrite a human's `delivered` row for the same key", async () => {
    // `delivered` is a revocable claim, but it is still a row that means the room has this copy —
    // `deliveredToRoom` says so, and `send:channels` skips on it. Overwriting it to `sent` would take
    // away the human's ability to untick 전달함, which is not this class's call to make.
    const { ledger, added } = fakeLedger([{ ...entry, status: "delivered", postId: undefined, url: undefined }]);
    expect(await new RecordObservedDelivery(ledger).record(entry)).toBe("already-recorded");
    expect(added).toEqual([]);
  });

  it("replaces a dropped row, and reports that it did rather than calling it a plain write", async () => {
    // `dropped` means a scheduled Typefully draft was deleted before publishing, so nothing reached
    // the account — `deliveredToRoom` excludes it from every ledger's loadKeys() for that reason, and
    // send:channels treats the room as sendable again. A >=0.95 match against a LIVE post is newer and
    // stronger evidence: the copy is on the account now. Leaving the dropped row would keep the board
    // saying "never went out" about a post anyone can open, and leave send:channels free to post it a
    // second time. So the overwrite is right — but it must be a named, printed outcome. It used to be
    // an accident: the guard read loadKeys() (which drops this row) and `add` is an upsert, so it was
    // silently rewritten and reported as `✓ recorded` while the doc comment claimed it never overwrote
    // anything.
    const { ledger, added, rows } = fakeLedger([{ ...entry, status: "dropped", postId: "55", by: "auto" }]);
    const result = await new RecordObservedDelivery(ledger).record(entry);
    expect(result).toBe("replaced-dropped");
    expect(added).toEqual([entry]);
    expect(rows).toHaveLength(1); // upserted in place, not appended as a second row for one key
    expect(rows[0].status).toBe("sent");
    expect(rows[0].postId).toBe("100");
  });

  it("does not confuse a dropped row for a DIFFERENT key with this one", async () => {
    const { ledger } = fakeLedger([{ ...entry, itemId: "x:2", status: "dropped" }]);
    expect(await new RecordObservedDelivery(ledger).record(entry)).toBe("written");
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
