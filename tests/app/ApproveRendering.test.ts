import { describe, it, expect } from "vitest";
import { ApproveRendering } from "../../src/app/ApproveRendering";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import type { FewShotStore } from "../../src/ports/FewShotStore";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import { ALL_TYPES, type ContentVariant, type ConversionType } from "../../src/domain/conversion/models";
import type { FewShotExample } from "../../src/domain/translation/models";

function rnd(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "telegram", text: "t", refined: false,
    createdAt: "2026-01-01T00:00:00.000Z", status: "rendered", ...over };
}
function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피",
    status: "converted", createdAt: "2026-01-01T00:00:00.000Z", ...over };
}

function harness(renderings: ChannelRendering[], variants: ContentVariant[] = [variant()]) {
  let list = renderings.map((r) => ({ ...r }));
  const formatting: FormattingStore = {
    loadAll: async () => list,
    listRenderedKeys: async () => new Set(list.map((r) => `${r.itemId}:${r.type}:${r.channel}`)),
    upsert: async (r) => { list = [...list.filter((x) => !(x.itemId === r.itemId && x.type === r.type && x.channel === r.channel)), r]; },
  };

  let vars = variants.map((v) => ({ ...v }));
  const conversion: ConversionStore = {
    loadAll: async () => vars,
    listConvertedKeys: async () => new Set(vars.map((v) => `${v.itemId}:${v.type}`)),
    upsert: async (v) => { vars = [...vars.filter((x) => !(x.itemId === v.itemId && x.type === v.type)), v]; },
  };

  // `add` upserts by itemId, mirroring `JsonFewShotStore` — the dedup behaviour under test.
  const fewShots = {} as Record<ConversionType, FewShotExample[]>;
  const fewShotByType = {} as Record<ConversionType, FewShotStore>;
  for (const t of ALL_TYPES) {
    fewShots[t] = [];
    fewShotByType[t] = {
      load: async () => fewShots[t],
      add: async (e) => {
        const i = fewShots[t].findIndex((x) => x.itemId === e.itemId);
        if (i >= 0) fewShots[t][i] = e; else fewShots[t].push(e);
      },
    };
  }

  return { formatting, conversion, fewShotByType, fewShots, renderings: () => list, variants: () => vars };
}

describe("ApproveRendering", () => {
  it("sets status approved + approvedAt on the matching rendering", async () => {
    const h = harness([rnd()]);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    expect(res?.status).toBe("approved");
    expect(res?.approvedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(res?.text).toBe("t"); // unchanged
    expect(h.renderings()[0].status).toBe("approved");
  });

  it("returns undefined when no rendering matches", async () => {
    const h = harness([rnd()]);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType);
    expect(await uc.run({ itemId: "x:9", type: "x", channel: "telegram" })).toBeUndefined();
  });

  /**
   * 2차 is the only point a human reads the converted copy, so it is the only point the corpus that
   * steers every later conversion may grow. Formatting no longer gates on the variant's status, so
   * without this the flywheel would never turn at all.
   */
  it("promotes the variant into its type's few-shot corpus, using the variant's own text", async () => {
    const h = harness([rnd({ type: "kol", text: "채널용으로 다듬은 글" })], [variant({ type: "kol" })]);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType, () => "2026-05-05T00:00:00.000Z");
    await uc.run({ itemId: "x:1", type: "kol", channel: "telegram" });
    expect(h.fewShots.kol).toEqual([{ source: "한글", target: "카피", itemId: "x:1" }]);
    expect(h.fewShots.x).toHaveLength(0);
  });

  it("marks the variant approved too, so `pnpm status` counts it", async () => {
    const h = harness([rnd()]);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType, () => "2026-05-05T00:00:00.000Z");
    await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    expect(h.variants()[0].status).toBe("approved");
    expect(h.variants()[0].approvedAt).toBe("2026-05-05T00:00:00.000Z");
  });

  /** One variant fans out to several channels; approving each must not stack duplicate examples. */
  it("approving a second channel of the same type does not duplicate the few-shot entry", async () => {
    const h = harness([rnd({ channel: "telegram" }), rnd({ channel: "kakao" })]);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType, () => "2026-05-05T00:00:00.000Z");
    await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    await uc.run({ itemId: "x:1", type: "x", channel: "kakao" });
    expect(h.fewShots.x).toHaveLength(1);
  });

  it("approves the rendering even when no variant sits behind it", async () => {
    const h = harness([rnd()], []);
    const uc = new ApproveRendering(h.formatting, h.conversion, h.fewShotByType, () => "2026-05-05T00:00:00.000Z");
    const res = await uc.run({ itemId: "x:1", type: "x", channel: "telegram" });
    expect(res?.status).toBe("approved");
    expect(h.fewShots.x).toHaveLength(0);
  });
});
