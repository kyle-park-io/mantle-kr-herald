import { describe, it, expect } from "vitest";
import { SaveConversion } from "../../src/app/SaveConversion";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { ContentVariant } from "../../src/domain/conversion/models";

function harness() {
  const saved: ContentVariant[] = [];
  const store: ConversionStore = {
    loadAll: async () => saved, listConvertedKeys: async () => new Set(),
    upsert: async (v) => { saved.push(v); },
  };
  return { saved, store };
}

describe("SaveConversion", () => {
  it("always saves as converted — the agent's copy is never self-approved", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, () => "2026-02-02T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피" });
    expect(res).toEqual({ itemId: "x:1", type: "x" });
    expect(h.saved[0].status).toBe("converted");
    expect(h.saved[0].approvedAt).toBeUndefined();
  });

  /**
   * A re-save is how an agent rewrites copy the reviewer sent back. It must not quietly inherit the
   * approval the first round earned at 2차, or the rewritten text would be sendable unread.
   */
  it("re-saving an already-approved variant drops it back to converted", async () => {
    const h = harness();
    h.saved.push({ itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "옛 카피",
      status: "approved", createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" });
    const uc = new SaveConversion(h.store, () => "2026-02-02T00:00:00.000Z");
    await uc.run({ itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "새 카피" });
    const latest = h.saved[h.saved.length - 1];
    expect(latest.convertedText).toBe("새 카피");
    expect(latest.status).toBe("converted");
    expect(latest.approvedAt).toBeUndefined();
  });
});
