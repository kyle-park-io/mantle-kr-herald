import { describe, it, expect } from "vitest";
import { ApproveRendering } from "../../src/app/ApproveRendering";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function rnd(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "telegram", text: "t", refined: false,
    createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over };
}
function store(list: ChannelRendering[]) {
  const state = { list: list.map((r) => ({ ...r })) };
  const s: FormattingStore = {
    loadAll: async () => state.list,
    listRenderedKeys: async () => new Set(state.list.map((r) => `${r.itemId}:${r.type}:${r.channel}`)),
    upsert: async (r) => { state.list = [...state.list.filter((x) => !(x.itemId === r.itemId && x.type === r.type && x.channel === r.channel)), r]; },
  };
  return { s, state };
}

describe("ApproveRendering", () => {
  it("sets status approved + approvedAt on the matching rendering", async () => {
    const { s, state } = store([rnd()]);
    const uc = new ApproveRendering(s, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    expect(res?.status).toBe("approved");
    expect(res?.approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(res?.text).toBe("t"); // unchanged
    expect(state.list[0].status).toBe("approved");
  });

  it("returns undefined when no rendering matches", async () => {
    const { s } = store([rnd()]);
    const uc = new ApproveRendering(s);
    expect(await uc.run({ itemId: "x:9", type: "x", channel: "telegram" })).toBeUndefined();
  });
});
