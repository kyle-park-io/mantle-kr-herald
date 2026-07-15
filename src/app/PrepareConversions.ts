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
}

export interface PendingVariant {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
}

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
  ) {}

  async run(selector: ConversionSelector): Promise<{ worksheet: string; pending: PendingVariant[] }> {
    const approved = (await this.translationStore.loadAll()).filter((t) => t.status === "approved");
    const convertedKeys = await this.conversionStore.listConvertedKeys();
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;

    let candidates: (PendingVariant & { at: string })[] = [];
    for (const type of types) {
      for (const t of approved) {
        if (convertedKeys.has(`${t.itemId}:${type}`)) continue;
        candidates.push({ itemId: t.itemId, type, sourceKorean: t.koreanText, at: t.approvedAt ?? t.translatedAt });
      }
    }
    if (wantedIds) candidates = candidates.filter((c) => wantedIds.has(c.itemId));
    if (selector.since) {
      const since = selector.since;
      candidates = candidates.filter((c) => c.at >= since);
    }
    candidates = candidates.slice(0, selector.limit ?? DEFAULT_LIMIT);

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
    const pending = candidates.map((c) => ({ itemId: c.itemId, type: c.type, sourceKorean: c.sourceKorean }));
    return { worksheet, pending };
  }
}
