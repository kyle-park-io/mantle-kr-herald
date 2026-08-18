import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { assembleConversionWorksheet, assembleTypeSection } from "../domain/conversion/promptAssembler";
import type { TranslationStore } from "../ports/TranslationStore";
import type { GlossaryStore } from "../ports/GlossaryStore";
import type { TranslationConfig } from "../ports/TranslationConfig";
import type { ConversionConfig } from "../ports/ConversionConfig";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FewShotStore } from "../ports/FewShotStore";

export interface ConversionSelector {
  ids?: string[];
  since?: string;
  limit?: number;
  types?: ConversionType[];
  /**
   * A ceiling on the (item, type) pairs this run may produce, applied AFTER the fan-out below —
   * which is the only place it can be applied, because `limit` counts source items and the fan-out
   * is what turns one of those into up to seven pieces of copy.
   *
   * It exists because those pairs, not the items, are what a single `claude -p` call has to write
   * inside `ClaudeCodeAgent`'s ten-minute cap. On 2026-08-17 one item with all seven types
   * unconverted took an estimated twelve minutes: the agent saved five and was killed mid-sixth.
   * Lowering `limit` could not have prevented that — it was already 1.
   *
   * Omitted means no ceiling, which is what a hand-run `pnpm convert:prepare` and the dashboard's
   * `[변환 준비]` button both get: a human watching a terminal is not on a timer, and neither is a
   * button that reports what it prepared. The conversion scheduler is the caller that sets it.
   */
  maxVariants?: number;
}

export interface PendingVariant {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
}

/**
 * The one type the agent never sees.
 *
 * `x` goes to @0xMantleKR, and the item it comes from is a tweet — so the Korean the 1차 reviewer
 * approved already IS the post. Every other type is a rewrite for a different audience (a Telegram
 * 공지, a KOL brief, a press release); `x` is the same text arriving at its own account. Handing it
 * to the agent re-opened wording a human had signed off on, and it showed: on 2026-08-18 all ten
 * `x` variants in production differed from their own `sourceKorean`, and the six `conversion:x`
 * few-shot rows were teaching the rewrite back into every later run.
 *
 * Enforced here rather than in `conversion/x.md` because a prompt is a request and this is a rule —
 * the guide now documents it for the 2차 reviewer instead of asking the agent to honour it.
 */
const PASSTHROUGH_TYPE: ConversionType = "x";

const DEFAULT_LIMIT = 20;
const MAX_FEW_SHOTS = 8;

export class PrepareConversions {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly glossaryStore: GlossaryStore,
    private readonly config: TranslationConfig,
    private readonly conversionConfig: ConversionConfig,
    private readonly fewShotByType: Record<ConversionType, FewShotStore>,
    private readonly conversionStore: ConversionStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(selector: ConversionSelector): Promise<{ worksheet: string; pending: PendingVariant[]; passthrough: PendingVariant[] }> {
    const approved = (await this.translationStore.loadAll()).filter((t) => t.status === "approved");
    const convertedKeys = await this.conversionStore.listConvertedKeys();
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;

    // Apply the selector to the source translations FIRST, so --limit counts items and
    // every selected item always carries all of its (not-yet-converted) types.
    let selected = approved;
    if (wantedIds) selected = selected.filter((t) => wantedIds.has(t.itemId));
    if (selector.since) {
      const since = selector.since;
      selected = selected.filter((t) => (t.approvedAt ?? t.translatedAt) >= since);
    }
    // Nothing left to convert → not a candidate for a slot, and this line has to come BEFORE the
    // slice. It is a limit on work, not on rows read: an item still `approved` long after all its
    // types were converted is finished as far as this use case is concerned, and counting it left
    // the scheduler's `--limit 1` holding its only slot for an item with no candidate types.
    //
    // 2026-08-12: two items approved eight seconds apart. The 06:38 tick converted the first; every
    // tick from 07:08 to 09:38 then prepared 0 variant(s) — "nothing approved is waiting" — while
    // the second item, six types unconverted, sat behind it. It only stopped being starved when
    // reconcile retired BOTH to `posted` at 09:42, by which point it had never reached 2차 검수.
    // Scoped to `types`, not ALL_TYPES: under `--types x` an item converted for `x` is done for
    // *this* run, and holding a slot for its other six types would starve the queue the same way.
    selected = selected.filter((t) => types.some((type) => !convertedKeys.has(`${t.itemId}:${type}`)));
    selected = selected.slice(0, selector.limit ?? DEFAULT_LIMIT);

    // Fan out each selected translation to its not-yet-converted types (type-major, so
    // the worksheet sections stay grouped by type). `x` splits off here: it is written straight
    // from the approved Korean instead of joining the agent's pile — see `PASSTHROUGH_TYPE`.
    const fanned: PendingVariant[] = [];
    const passthrough: PendingVariant[] = [];
    for (const type of types) {
      for (const t of selected) {
        if (convertedKeys.has(`${t.itemId}:${type}`)) continue;
        (type === PASSTHROUGH_TYPE ? passthrough : fanned).push({ itemId: t.itemId, type, sourceKorean: t.koreanText });
      }
    }

    // Written before the worksheet is even assembled, and deliberately outside the `maxVariants`
    // slice below: that ceiling is arithmetic against `claude -p`'s ten-minute cap, and a row this
    // loop writes costs the agent nothing — no section to read, no save to wait for.
    const at = this.now();
    for (const p of passthrough) {
      await this.conversionStore.upsert({
        itemId: p.itemId, type: p.type, sourceKorean: p.sourceKorean, convertedText: p.sourceKorean,
        status: "converted", createdAt: at,
      });
    }

    // The ceiling, applied to the fan-out and to nothing else — see `maxVariants` for why it cannot
    // live on `limit`. Type-major order makes this slice breadth-first across the selected items: at
    // `maxVariants` 4 with two items it takes both items' first two types, rather than one item's
    // four and none of the other's. Whatever is dropped here is not lost, only deferred — the pair
    // still has no variant row, so the next tick's `listConvertedKeys` offers it again.
    const candidates = selector.maxVariants === undefined ? fanned : fanned.slice(0, selector.maxVariants);

    const glossary = await this.glossaryStore.load();
    const locale = await this.config.loadLocale();

    const sections: string[] = [];
    for (const type of types) {
      const items = candidates.filter((c) => c.type === type).map((c) => ({ itemId: c.itemId, sourceKorean: c.sourceKorean }));
      if (items.length === 0) continue;
      const guide = await this.conversionConfig.loadTypeGuide(type);
      const fewShots = (await this.fewShotByType[type].load()).slice(-MAX_FEW_SHOTS);
      sections.push(assembleTypeSection({ type, guideText: guide.text, glossary, locale, fewShots, items }));
    }

    const worksheet = assembleConversionWorksheet(sections);
    return { worksheet, pending: candidates, passthrough };
  }
}
