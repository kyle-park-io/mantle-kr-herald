import { describe, it, expect } from "vitest";
import { SaveRendering } from "../../src/app/SaveRendering";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelRendering } from "../../src/domain/formatting/models";

describe("SaveRendering", () => {
  it("upserts a refined:true rendering", async () => {
    const saved: ChannelRendering[] = [];
    const store: FormattingStore = { loadAll: async () => saved, listRenderedKeys: async () => new Set(), upsert: async (r) => { saved.push(r); } };
    const uc = new SaveRendering(store, () => "2026-04-04T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트" });
    expect(res).toEqual({ itemId: "x:1", type: "kol", channel: "telegram" });
    expect(saved[0]).toEqual({ itemId: "x:1", type: "kol", channel: "telegram", text: "다듬은 텍스트", refined: true, createdAt: "2026-04-04T00:00:00.000Z", status: "rendered" });
  });
});
