import { describe, expect, it } from "vitest";
import { SaveOutletOverride } from "../../src/app/SaveOutletOverride";
import { overrideKey, type OutletOverride } from "../../src/domain/outlet/override";

function fakeStore(seed: OutletOverride[] = []) {
  let rows = [...seed];
  return {
    loadAll: async () => rows,
    upsert: async (o: OutletOverride) => { rows = [...rows.filter((r) => overrideKey(r) !== overrideKey(o)), o]; },
    remove: async (key: string) => { rows = rows.filter((r) => overrideKey(r) !== key); },
    rows: () => rows,
  };
}
const args = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain" };

describe("SaveOutletOverride", () => {
  it("forks a room at rendered when its text is edited", async () => {
    const s = fakeStore();
    const saved = await new SaveOutletOverride(s, () => "T").run({ ...args, text: "이 방 전용" });
    expect(saved?.status).toBe("rendered");
    expect(s.rows()).toHaveLength(1);
  });

  it("keeps the original createdAt when the fork is edited again", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, text: "v2" });
    expect(saved?.createdAt).toBe("T1");
  });

  it("re-forks to rendered when an approved fork is edited", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "approved", createdAt: "T1", approvedAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, text: "v2" });
    expect(saved?.status).toBe("rendered");
    expect(saved?.approvedAt).toBeUndefined();
  });

  it("approves an existing fork", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2").run({ ...args, approve: true });
    expect(saved?.status).toBe("approved");
    expect(saved?.approvedAt).toBe("T2");
  });

  it("refuses to approve a room that was never forked", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T").run({ ...args, approve: true })).rejects.toThrow(/no override/i);
  });

  it("reverts a fork so the room falls back to the group text", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    await new SaveOutletOverride(s, () => "T2").run({ ...args, revert: true });
    expect(s.rows()).toEqual([]);
  });

  it("rejects an unknown outlet", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T").run({ ...args, outletId: "nope", text: "x" })).rejects.toThrow(/unknown outlet/i);
  });
});

describe("SaveOutletOverride — 승인 취소", () => {
  it("drops an approved fork back to rendered and clears the stamp", async () => {
    const s = fakeStore([{ ...args, text: "이 방 전용", status: "approved", createdAt: "T0", approvedAt: "T1" }]);
    const res = await new SaveOutletOverride(s, () => "T2").run({ ...args, approve: false });
    expect(res?.status).toBe("rendered");
    expect(res?.approvedAt).toBeUndefined();
    expect(res?.text).toBe("이 방 전용"); // the copy itself is untouched
  });

  /**
   * `approve: false` has to be told apart from "no approve field": read as absent it would fall
   * through to the text branch and throw `nothing to save` on a perfectly valid 승인 취소.
   */
  it("refuses to unapprove a room that has no override of its own", async () => {
    const uc = new SaveOutletOverride(fakeStore(), () => "T2");
    await expect(uc.run({ ...args, approve: false })).rejects.toThrow(/unapprove/);
  });
});
