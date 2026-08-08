import { describe, it, expect } from "vitest";
import { FormatVariants } from "../../src/app/FormatVariants";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import { renderingKey, type FormattingStore } from "../../src/ports/FormattingStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
/**
 * `existing` is what the store already holds when the run starts; `saved` is only what this run
 * upserted. Kept as two lists rather than one mutable store on purpose: "did it write this row?"
 * and "does this row exist?" are different questions, and the only-missing mode below is exactly
 * the case where a row can exist without this run having written it.
 */
function stores(variants: ContentVariant[], existing: ChannelRendering[] = []) {
  const conversionStore: ConversionStore = { loadAll: async () => variants, upsert: async () => {}, listConvertedKeys: async () => new Set() };
  const saved: ChannelRendering[] = [];
  const all = () => [...existing, ...saved];
  const formattingStore: FormattingStore = {
    loadAll: async () => all(),
    listRenderedKeys: async () => new Set(all().map(renderingKey)),
    upsert: async (r) => { saved.push(r); },
  };
  return { conversionStore, formattingStore, saved };
}
function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "사람이 고쳐 둔 문구", refined: true,
    createdAt: "2026-02-02T00:00:00.000Z", status: "approved", approvedAt: "2026-02-03T00:00:00.000Z", ...over };
}

describe("FormatVariants", () => {
  it("formats approved variants to their default channels and persists refined:false renderings", async () => {
    // announcement is the multi-channel type: one variant fans out to telegram + kakao
    const s = stores([variant({ type: "announcement" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({});
    expect(renderings.map((r) => r.channel)).toEqual(["telegram", "kakao"]);
    expect(renderings.every((r) => r.refined === false)).toBe(true);
    expect(s.saved).toHaveLength(2);
  });

  /**
   * Formatting is mechanical and nothing leaves the machine, so a variant does not need its own
   * approval to be rendered — 2차 is the gate, and `SendChannels` enforces it on the rendering. If
   * this ever filtered on status again, pressing [포맷 다시] on the board would silently do nothing.
   */
  it("formats a converted variant that has not been approved", async () => {
    const s = stores([variant({ status: "converted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings } = await uc.run({});
    expect(renderings).toHaveLength(1);
    expect(renderings[0].status).toBe("rendered");
  });

  it("honors --channels override and collects warnings", async () => {
    const s = stores([variant({ convertedText: "가".repeat(281) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings, warnings } = await uc.run({ channels: ["x"] });
    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(warnings[0].messages.some((m) => m.includes("280"))).toBe(true);
  });

  it("filters by --ids (only the requested items are formatted)", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x" }), variant({ itemId: "x:2", type: "x" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "t");
    const { renderings } = await uc.run({ ids: ["x:2"], channels: ["x"] });
    expect(renderings.map((r) => r.itemId)).toEqual(["x:2"]);
  });

  it("filters by --types (only the requested types are formatted)", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x" }), variant({ itemId: "x:1", type: "kol" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "t");
    const { renderings } = await uc.run({ types: ["kol"], channels: ["telegram"] });
    expect(renderings.map((r) => r.type)).toEqual(["kol"]);
  });

  /** Telegram, because it is the channel that renders bold — see "bold per channel" below. */
  it("stores canonical text — bold and links survive, destination syntax does not", async () => {
    const s = stores([variant({ convertedText: "  **메인넷**\r\n\n\n\n\n[자세히](https://x.io)  " })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({ channels: ["telegram"] });
    expect(renderings[0].text).toBe("**메인넷**\n\n\n[자세히](https://x.io)");
  });

  /** Link syntax is content — a label and a URL — so it stays even where nothing renders it. */
  it("keeps link syntax on a channel that strips bold", async () => {
    const s = stores([variant({ convertedText: "**메인넷** [자세히](https://x.io)" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({ channels: ["kakao"] });
    expect(renderings[0].text).toBe("메인넷 [자세히](https://x.io)");
  });

  it("warns via the channel's destinations, counting Hangul as 2 for x, and names both x destinations once", async () => {
    const s = stores([variant({ type: "x", convertedText: "가".repeat(141) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
    const { warnings } = await uc.run({});
    expect(warnings[0].messages).toEqual(["x_paste, x_typefully: 282/280 (2 초과)"]);
  });

  it("does not warn an over-280 x variant when xMaxWeighted is 25000", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x", convertedText: "가".repeat(150) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, undefined, 25000);
    const { renderings, warnings } = await uc.run({ types: ["x"] });
    expect(renderings.some((r) => r.channel === "x")).toBe(true);
    expect(warnings).toEqual([]); // 300 weighted is under 25000 → no 초과 warning
  });
});

/**
 * The mode the scheduled tick runs in (`src/app/ConvertTick.ts` → `pnpm format --only-missing`), and
 * the reason it had to exist before that stage could be wired at all: everything this class emits is
 * `status: "rendered"`, `refined: false`, canonical text, upserted over whatever was there. Run
 * unselected on a 30-minute timer, that discards every edit and every approval 2차 검수 has produced,
 * twice an hour, with no trace.
 */
describe("FormatVariants — only-missing", () => {
  it("leaves an existing rendering completely alone — it is not re-upserted, not even identically", async () => {
    // Asserted as "upsert was never called for this pair", not as "the stored row still looks right":
    // the row this class would write is byte-identical to a *fresh* rendering, so a store that
    // compared before/after values could not tell a skip from an overwrite of an unedited row. The
    // rows that matter are the edited ones, and those are only safe if the write never happens.
    const s = stores([variant()], [rendering()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(s.saved).toEqual([]);
    expect(renderings).toEqual([]);
  });

  it("still formats the pairs that have no rendering yet, in the same run", async () => {
    // One `announcement` variant fans out to telegram + kakao. With telegram already rendered, the
    // run must skip that one and still produce kakao — "skip the item" rather than "skip the pair"
    // would leave the 카카오 card permanently missing.
    const s = stores(
      [variant({ type: "announcement" })],
      [rendering({ type: "announcement", channel: "telegram" })],
    );
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(renderings.map((r) => r.channel)).toEqual(["kakao"]);
    expect(s.saved.map((r) => r.channel)).toEqual(["kakao"]);
  });

  it("keys the skip by channel as well as item and type, exactly as the store does", async () => {
    // The whole mode rests on `renderingKey`. A membership test that dropped the channel would treat
    // the rendered X card as covering the telegram one and skip a pair that does not exist yet; one
    // that dropped the type would do the same across types. Both are silent — the board simply never
    // grows the missing card.
    const s = stores(
      [variant({ type: "kol" }), variant({ type: "x" })],
      [rendering({ type: "x", channel: "x" })],
    );
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(renderings.map((r) => `${r.type}:${r.channel}`)).toEqual(["kol:telegram"]);
  });

  it("warns only about what it actually wrote", async () => {
    // A warning is a statement about an emission. Re-reporting one for a pair this run deliberately
    // left alone would put a length complaint about a reviewer's own edited text into a journal
    // every 30 minutes, forever, for text this run never looked at.
    const s = stores([variant({ convertedText: "가".repeat(141) })], [rendering()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);

    const { warnings } = await uc.run({}, { onlyMissing: true });

    expect(warnings).toEqual([]);
  });

  it("overwrites by default, because that is what [포맷 다시] and a hand-run pnpm format are for", async () => {
    // The discriminating half, and invariant #3 of the change that added the mode above: the
    // dashboard's red button regenerates a card *on purpose* (docs/ko/review.md warns that it
    // discards the saved text and the approval), and `pnpm format --ids …` is how an operator
    // re-renders after re-saving a conversion. Making the skip the default would break both.
    const s = stores([variant()], [rendering()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({});

    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].status).toBe("rendered");
    expect(s.saved[0].refined).toBe(false);
  });
});

/**
 * Bold survives to the channels that can render it and is dropped from the ones that cannot — and
 * the same variant does both at once, which is why the decision cannot move back to the variant.
 */
describe("FormatVariants — bold per channel", () => {
  const bolded = () => variant({ type: "announcement", convertedText: "📢 **제목**\n\n**[소제목]**\n본문" });

  it("keeps bold for telegram and drops it for kakao, from one variant", async () => {
    const s = stores([bolded()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings } = await uc.run({ channels: ["telegram", "kakao"] });
    const byChannel = Object.fromEntries(renderings.map((r) => [r.channel, r.text]));
    expect(byChannel.telegram).toContain("**제목**");
    expect(byChannel.kakao).not.toContain("**");
    // The words survive — only the markers go.
    expect(byChannel.kakao).toContain("📢 제목");
    expect(byChannel.kakao).toContain("[소제목]");
  });

  it("drops bold for x and pr_mail too", async () => {
    const s = stores([bolded()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore);
    const { renderings } = await uc.run({ channels: ["x", "pr_mail"] });
    for (const r of renderings) expect(r.text, `bold left in ${r.channel}`).not.toContain("**");
  });
});
