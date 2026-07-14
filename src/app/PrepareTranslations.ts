import { DEFAULT_ROLE } from "../domain/translation/role";
import { assembleItemBlock, assembleSharedContext } from "../domain/translation/promptAssembler";
import type { ContentItem } from "../domain/translation/contentItem";
import type { ContentSource } from "../ports/ContentSource";
import type { GlossaryStore } from "../ports/GlossaryStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { TranslationStore } from "../ports/TranslationStore";
import type { TranslationConfig } from "../ports/TranslationConfig";

export interface Selector {
  ids?: string[];
  since?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_FEW_SHOTS = 8;

export class PrepareTranslations {
  constructor(
    private readonly source: ContentSource,
    private readonly glossaryStore: GlossaryStore,
    private readonly fewShotStore: FewShotStore,
    private readonly config: TranslationConfig,
    private readonly translationStore: TranslationStore,
    private readonly role: string = DEFAULT_ROLE,
  ) {}

  async run(selector: Selector): Promise<{ worksheet: string; pending: ContentItem[] }> {
    const translatedIds = await this.translationStore.listTranslatedIds();
    let pending = await this.source.loadPending(translatedIds);
    pending = this.applySelector(pending, selector);

    const [glossary, styleGuide, locale, fewShots] = await Promise.all([
      this.glossaryStore.load(),
      this.config.loadStyleGuide(),
      this.config.loadLocale(),
      this.fewShotStore.load(),
    ]);

    const header = assembleSharedContext({
      role: this.role,
      glossary,
      styleGuide,
      locale,
      fewShots: fewShots.slice(-MAX_FEW_SHOTS),
    });
    const blocks = pending.map((item) => assembleItemBlock(item));
    const worksheet = [header, ...blocks].join("\n");

    return { worksheet, pending };
  }

  private applySelector(items: ContentItem[], selector: Selector): ContentItem[] {
    let result = items;
    if (selector.ids && selector.ids.length > 0) {
      const wanted = new Set(selector.ids);
      result = result.filter((i) => wanted.has(i.id));
    }
    if (selector.since) {
      const since = selector.since;
      result = result.filter((i) => i.createdAt >= since);
    }
    const limit = selector.limit ?? DEFAULT_LIMIT;
    return result.slice(0, limit);
  }
}
