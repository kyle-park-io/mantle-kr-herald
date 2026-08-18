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
    const saved = await new SaveOutletOverride(s, () => "T", undefined, "agent").run({ ...args, text: "이 방 전용" });
    expect(saved?.status).toBe("rendered");
    expect(s.rows()).toHaveLength(1);
  });

  it("keeps the original createdAt when the fork is edited again", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2", undefined, "agent").run({ ...args, text: "v2" });
    expect(saved?.createdAt).toBe("T1");
  });

  it("re-forks to rendered when an approved fork is edited", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "approved", createdAt: "T1", approvedAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2", undefined, "agent").run({ ...args, text: "v2" });
    expect(saved?.status).toBe("rendered");
    expect(saved?.approvedAt).toBeUndefined();
  });

  it("approves an existing fork", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    const saved = await new SaveOutletOverride(s, () => "T2", undefined, "agent").run({ ...args, approve: true });
    expect(saved?.status).toBe("approved");
    expect(saved?.approvedAt).toBe("T2");
  });

  it("refuses to approve a room that was never forked", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T", undefined, "agent").run({ ...args, approve: true })).rejects.toThrow(/no override/i);
  });

  it("reverts a fork so the room falls back to the group text", async () => {
    const s = fakeStore([{ ...args, text: "v1", status: "rendered", createdAt: "T1" }]);
    await new SaveOutletOverride(s, () => "T2", undefined, "agent").run({ ...args, revert: true });
    expect(s.rows()).toEqual([]);
  });

  it("rejects an unknown outlet", async () => {
    const s = fakeStore();
    await expect(new SaveOutletOverride(s, () => "T", undefined, "agent").run({ ...args, outletId: "nope", text: "x" })).rejects.toThrow(/unknown outlet/i);
  });
});

describe("SaveOutletOverride — 승인 취소", () => {
  it("drops an approved fork back to rendered and clears the stamp", async () => {
    const s = fakeStore([{ ...args, text: "이 방 전용", status: "approved", createdAt: "T0", approvedAt: "T1" }]);
    const res = await new SaveOutletOverride(s, () => "T2", undefined, "agent").run({ ...args, approve: false });
    expect(res?.status).toBe("rendered");
    expect(res?.approvedAt).toBeUndefined();
    expect(res?.text).toBe("이 방 전용"); // the copy itself is untouched
  });

  /**
   * `approve: false` has to be told apart from "no approve field": read as absent it would fall
   * through to the text branch and throw `nothing to save` on a perfectly valid 승인 취소.
   */
  it("refuses to unapprove a room that has no override of its own", async () => {
    const uc = new SaveOutletOverride(fakeStore(), () => "T2", undefined, "agent");
    await expect(uc.run({ ...args, approve: false })).rejects.toThrow(/unapprove/);
  });
});

/**
 * A fork is edited in the same box, by the same person, as the group's text — so it has to be
 * stored the same way. It was not: the group ran through `toCanonical` and the fork did not, so the
 * emitters read a fork exactly as typed.
 */
describe("SaveOutletOverride — canonical text", () => {
  it("normalises a typed thread separator into a post boundary, as the group card does", async () => {
    const s = fakeStore();
    const saved = await new SaveOutletOverride(s, () => "T", undefined, "agent").run({ ...args, text: "첫 트윗.\n\n---\n\n둘째 트윗." });
    expect(saved?.text).toBe("첫 트윗.\n\n\n둘째 트윗.");
    expect(saved?.text).not.toContain("---"); // a literal separator would go out in the post
  });

  it("trims and collapses like the group card does", async () => {
    const s = fakeStore();
    const saved = await new SaveOutletOverride(s, () => "T", undefined, "agent").run({ ...args, text: "  본문\r\n\n\n\n\n다음 문단  " });
    expect(saved?.text).toBe("본문\n\n\n다음 문단");
  });
});
