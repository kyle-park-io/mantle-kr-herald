import { describe, it, expect } from "vitest";
import { FormatVariants } from "../../src/app/FormatVariants";
import type { ConversionStore } from "../../src/ports/ConversionStore";
import { renderingKey, type FormattingStore } from "../../src/ports/FormattingStore";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { ContentVariant } from "../../src/domain/conversion/models";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { Translation } from "../../src/domain/translation/models";

function variant(over: Partial<ContentVariant> = {}): ContentVariant {
  return { itemId: "x:1", type: "x", sourceKorean: "한글", convertedText: "카피", status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z", ...over };
}
function translation(over: Partial<Translation> = {}): Translation {
  return { itemId: "x:1", source: "x", sourceText: "source", koreanText: "한글", status: "approved",
    translatedAt: "2026-01-01T00:00:00.000Z", ...over };
}
/**
 * `existing` is what the store already holds when the run starts; `saved` is only what this run
 * upserted. Kept as two lists rather than one mutable store on purpose: "did it write this row?"
 * and "does this row exist?" are different questions, and the only-missing mode below is exactly
 * the case where a row can exist without this run having written it.
 *
 * `translations` defaults to empty rather than to a row per variant, and every test above the
 * "already posted" block below relies on that: a variant with no translation row at all must
 * format exactly as it always did (see that block's own "an item with no translation row" case).
 */
function stores(variants: ContentVariant[], existing: ChannelRendering[] = [], translations: Translation[] = []) {
  const conversionStore: ConversionStore = { loadAll: async () => variants, upsert: async () => {}, listConvertedKeys: async () => new Set() };
  const saved: ChannelRendering[] = [];
  const all = () => [...existing, ...saved];
  const formattingStore: FormattingStore = {
    loadAll: async () => all(),
    listRenderedKeys: async () => new Set(all().map(renderingKey)),
    upsert: async (r) => { saved.push(r); },
  };
  const translationStore: TranslationStore = {
    loadAll: async () => translations,
    upsert: async () => {},
    listTranslatedIds: async () => new Set(translations.map((t) => t.itemId)),
  };
  return { conversionStore, formattingStore, translationStore, saved };
}
function rendering(over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId: "x:1", type: "x", channel: "x", text: "사람이 고쳐 둔 문구", refined: true,
    createdAt: "2026-02-02T00:00:00.000Z", status: "approved", approvedAt: "2026-02-03T00:00:00.000Z", ...over };
}

describe("FormatVariants", () => {
  it("formats approved variants to their default channels and persists refined:false renderings", async () => {
    // The two 공지 types, which is how one piece of news reaches telegram and kakao since the split
    // — one variant each, not one variant fanned out to both (`DEFAULT_CHANNELS_BY_TYPE`). The run
    // is still selected per variant and rendered per channel, which is what this pins.
    const s = stores([variant({ type: "announcement" }), variant({ type: "kakao_notice" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");
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
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);
    const { renderings } = await uc.run({});
    expect(renderings).toHaveLength(1);
    expect(renderings[0].status).toBe("rendered");
  });

  it("honors --channels override and collects warnings", async () => {
    const s = stores([variant({ convertedText: "가".repeat(281) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);
    const { renderings, warnings } = await uc.run({ channels: ["x"] });
    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(warnings[0].messages.some((m) => m.includes("280"))).toBe(true);
  });

  it("filters by --ids (only the requested items are formatted)", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x" }), variant({ itemId: "x:2", type: "x" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");
    const { renderings } = await uc.run({ ids: ["x:2"], channels: ["x"] });
    expect(renderings.map((r) => r.itemId)).toEqual(["x:2"]);
  });

  it("filters by --types (only the requested types are formatted)", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x" }), variant({ itemId: "x:1", type: "kol" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");
    const { renderings } = await uc.run({ types: ["kol"], channels: ["telegram"] });
    expect(renderings.map((r) => r.type)).toEqual(["kol"]);
  });

  /** Telegram, because it is the channel that renders bold — see "bold per channel" below. */
  it("stores canonical text — bold and links survive, destination syntax does not", async () => {
    const s = stores([variant({ convertedText: "  **메인넷**\r\n\n\n\n\n[자세히](https://x.io)  " })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({ channels: ["telegram"] });
    expect(renderings[0].text).toBe("**메인넷**\n\n\n[자세히](https://x.io)");
  });

  /** Link syntax is content — a label and a URL — so it stays even where nothing renders it. */
  it("keeps link syntax on a channel that strips bold", async () => {
    const s = stores([variant({ convertedText: "**메인넷** [자세히](https://x.io)" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");
    const { renderings } = await uc.run({ channels: ["kakao"] });
    expect(renderings[0].text).toBe("메인넷 [자세히](https://x.io)");
  });

  it("warns via the channel's destinations, counting Hangul as 2 for x, and names both x destinations once", async () => {
    const s = stores([variant({ type: "x", convertedText: "가".repeat(141) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");
    const { warnings } = await uc.run({});
    expect(warnings[0].messages).toEqual(["x_paste, x_typefully: 282/280 (2 초과)"]);
  });

  it("does not warn an over-280 x variant when xMaxWeighted is 25000", async () => {
    const s = stores([variant({ itemId: "x:1", type: "x", convertedText: "가".repeat(150) })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, undefined, 25000);
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
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(s.saved).toEqual([]);
    expect(renderings).toEqual([]);
  });

  it("still formats the pairs that have no rendering yet, in the same run", async () => {
    // One variant covering two channels, with the first already rendered: the run must skip that
    // pair and still produce the second — "skip the item" rather than "skip the pair" would leave
    // the second card permanently missing.
    //
    // The two channels come from `--channels` rather than from a type's default fan-out, because
    // since the 공지 split no type has a default fan-out wider than one channel
    // (`DEFAULT_CHANNELS_BY_TYPE`). The override is the remaining way one variant covers several,
    // and it is the only shape that still isolates the *channel* axis of `renderingKey` — two
    // variants of different types would pass this even if the skip were keyed per variant, since
    // the second variant would be rendered either way. The type axis is pinned by the next test.
    const s = stores(
      [variant({ type: "announcement" })],
      [rendering({ type: "announcement", channel: "telegram" })],
    );
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({ channels: ["telegram", "kakao"] }, { onlyMissing: true });

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
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(renderings.map((r) => `${r.type}:${r.channel}`)).toEqual(["kol:telegram"]);
  });

  it("warns only about what it actually wrote", async () => {
    // A warning is a statement about an emission. Re-reporting one for a pair this run deliberately
    // left alone would put a length complaint about a reviewer's own edited text into a journal
    // every 30 minutes, forever, for text this run never looked at.
    const s = stores([variant({ convertedText: "가".repeat(141) })], [rendering()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);

    const { warnings } = await uc.run({}, { onlyMissing: true });

    expect(warnings).toEqual([]);
  });

  it("overwrites by default, because that is what [포맷 다시] and a hand-run pnpm format are for", async () => {
    // The discriminating half, and invariant #3 of the change that added the mode above: the
    // dashboard's red button regenerates a card *on purpose* (docs/ko/review.md warns that it
    // discards the saved text and the approval), and `pnpm format --ids …` is how an operator
    // re-renders after re-saving a conversion. Making the skip the default would break both.
    const s = stores([variant()], [rendering()]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({});

    expect(renderings.map((r) => r.channel)).toEqual(["x"]);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].status).toBe("rendered");
    expect(s.saved[0].refined).toBe(false);
  });
});

/**
 * The one gate that is about the *translation* rather than the variant: an item already published
 * and retired to `posted` is finished, and no run may build channel cards for it.
 *
 * Without this, `--only-missing` reads a finished item's absent cards as work to do and manufactures
 * them on the next 30-minute tick — so three retired items sat on the 2차 검수 board as unapproved
 * work that could not be cleared, and deleting their renderings by hand did not help: the variants
 * remain, and the next tick rebuilt every one of them.
 */
describe("FormatVariants — a posted translation is finished", () => {
  it("does not create a rendering for a variant whose translation is posted", async () => {
    // THE fix, in the mode that caused it: `--only-missing` sees "no rendering for (x:1, x, x)" and,
    // before this gate, wrote one — twice an hour, for an item that went out days ago.
    const s = stores([variant()], [], [translation({ status: "posted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}, { onlyMissing: true });

    expect(renderings).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  /**
   * The decision, pinned: the skip applies to **every** caller, exactly as `PublishTranslations`'
   * own `posted` skip does — a hand-run `pnpm format`, `pnpm format --ids …`, and the dashboard's
   * format route all get it, not just the scheduled `--only-missing` tick.
   *
   * Scoping it to the scheduled mode was the other candidate. It would have left a bare
   * `pnpm format` — documented in `docs/ko/review.md` as "rebuild every card" and run by hand after
   * a re-saved conversion — able to resurrect every card the human cleanup of those three retired
   * items had just deleted. The cleanup would not have survived one hand run.
   */
  it("does not overwrite one either — the skip is not scoped to the scheduled mode", async () => {
    const s = stores([variant()], [rendering()], [translation({ status: "posted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "2026-03-03T00:00:00.000Z");

    const { renderings } = await uc.run({}); // no onlyMissing: the overwrite mode

    expect(renderings).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it("reports the item it refused, so no caller is left holding a silent zero", async () => {
    // What that decision costs is that `[포맷 다시]` and `pnpm format --ids <posted>` render nothing.
    // A bare `rendered: 0` is indistinguishable from "the selector matched nothing", which is the
    // "appears to work and does nothing" shape this repo refuses elsewhere (`--only-missing`
    // + `--refine` throws rather than being ignored). The count is what `src/cli/format.ts` prints.
    const s = stores([variant({ itemId: "x:1" }), variant({ itemId: "x:2" })], [], [
      translation({ itemId: "x:1", status: "posted" }),
      translation({ itemId: "x:2", status: "posted" }),
    ]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { skippedPosted } = await uc.run({ channels: ["x"] });

    expect(skippedPosted).toEqual(["x:1", "x:2"]);
  });

  it("reports an item once, not once per channel it would have written", async () => {
    // `announcement` fans out to telegram + kakao. The number the CLI prints is items, not writes.
    const s = stores([variant({ type: "announcement" })], [], [translation({ status: "posted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { skippedPosted } = await uc.run({});

    expect(skippedPosted).toEqual(["x:1"]);
  });

  it("does not report an item whose cards all already exist under --only-missing", async () => {
    // "Skipped" means a rendering that WOULD have been written was not — which is why the gate sits
    // after the already-rendered check rather than before it. A posted item whose cards are all
    // still on the board is not work this run declined; reporting it would put a line in the
    // scheduler's run log every 30 minutes, forever, about nothing having happened.
    const s = stores([variant()], [rendering()], [translation({ status: "posted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { renderings, skippedPosted } = await uc.run({}, { onlyMissing: true });

    expect(renderings).toEqual([]);
    expect(skippedPosted).toEqual([]);
  });

  it("gates on posted only — a translated or approved source still formats", async () => {
    // The discriminating half. A gate that read "not approved" or "has a postedUrl" would pass every
    // assertion above and quietly stop the board filling at all.
    const s = stores(
      [variant({ itemId: "x:1" }), variant({ itemId: "x:2" })],
      [],
      [translation({ itemId: "x:1", status: "translated" }), translation({ itemId: "x:2", status: "approved" })],
    );
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { renderings, skippedPosted } = await uc.run({ channels: ["x"] });

    expect(renderings.map((r) => r.itemId)).toEqual(["x:1", "x:2"]);
    expect(skippedPosted).toEqual([]);
  });

  it("formats an item with no translation row at all — missing is not finished", async () => {
    // Only an explicit `posted` says "this went out". A missing row is a data anomaly, and refusing
    // to format on it would blank the board for the anomaly instead of reporting it; the send path
    // already blocks such a row loudly ("원문 번역을 찾을 수 없습니다", `sendBlock`).
    const s = stores([variant()], [], []);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { renderings, skippedPosted } = await uc.run({ channels: ["x"] });

    expect(renderings).toHaveLength(1);
    expect(skippedPosted).toEqual([]);
  });

  it("skips per item, not per run — the other items in the same run still format", async () => {
    // The posted set is read once for the whole run. A gate that bailed out of the loop, or that
    // matched on anything coarser than the itemId, would stop the scheduler dead the first time a
    // single retired item appeared in the selection.
    const s = stores(
      [variant({ itemId: "x:1" }), variant({ itemId: "x:2" })],
      [],
      [translation({ itemId: "x:1", status: "posted" })],
    );
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore, () => "t");

    const { renderings, skippedPosted } = await uc.run({ channels: ["x"] }, { onlyMissing: true });

    expect(renderings.map((r) => r.itemId)).toEqual(["x:2"]);
    expect(skippedPosted).toEqual(["x:1"]);
  });

  it("warns about nothing it refused to write", async () => {
    // Same rule as only-missing's own: a warning is a statement about an emission. An over-length
    // complaint about a finished item, every 30 minutes, is a warning nobody can act on.
    const s = stores([variant({ convertedText: "가".repeat(141) })], [], [translation({ status: "posted" })]);
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);

    const { warnings } = await uc.run({});

    expect(warnings).toEqual([]);
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
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);
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
    const uc = new FormatVariants(s.conversionStore, s.formattingStore, s.translationStore);
    const { renderings } = await uc.run({ channels: ["x", "pr_mail"] });
    for (const r of renderings) expect(r.text, `bold left in ${r.channel}`).not.toContain("**");
  });
});
