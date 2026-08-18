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
    const res = await uc.run({ itemId: "x:1", type: "announcement", sourceKorean: "한글", convertedText: "카피" });
    expect(res).toEqual({ itemId: "x:1", type: "announcement" });
    expect(h.saved[0].status).toBe("converted");
    expect(h.saved[0].approvedAt).toBeUndefined();
  });

  /**
   * The other half of the `x` passthrough, and the half that has to be a refusal rather than an
   * omission. `PrepareConversions` keeps `x` out of the worksheet, so no agent is *asked* for it —
   * but `convert:save` falls back to an already-saved variant's `sourceKorean` when the pair is not
   * in `pending.json`, and the passthrough always leaves one there. Without this, a stray
   * `pnpm convert:save --type x` (or an agent that went looking for work) would overwrite the
   * approved translation with a rewrite, through the one door the worksheet no longer opens.
   */
  it("refuses to save an x variant — that type is the approved translation, not something to rewrite", async () => {
    const h = harness();
    const uc = new SaveConversion(h.store, () => "2026-02-02T00:00:00.000Z");
    await expect(uc.run({ itemId: "x:1", type: "x", sourceKorean: "승인 카피", convertedText: "다시 쓴 글" }))
      .rejects.toThrow(/x/);
    expect(h.saved).toEqual([]);
  });

  /**
   * A re-save is how an agent rewrites copy the reviewer sent back. It must not quietly inherit the
   * approval the first round earned at 2차, or the rewritten text would be sendable unread.
   */
  it("re-saving an already-approved variant drops it back to converted", async () => {
    const h = harness();
    h.saved.push({ itemId: "x:1", type: "announcement", sourceKorean: "한글", convertedText: "옛 카피",
      status: "approved", createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" });
    const uc = new SaveConversion(h.store, () => "2026-02-02T00:00:00.000Z");
    await uc.run({ itemId: "x:1", type: "announcement", sourceKorean: "한글", convertedText: "새 카피" });
    const latest = h.saved[h.saved.length - 1];
    expect(latest.convertedText).toBe("새 카피");
    expect(latest.status).toBe("converted");
    expect(latest.approvedAt).toBeUndefined();
  });
});
