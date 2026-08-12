import { DEFAULT_ROLE } from "../domain/translation/role";
import { assembleItemBlock, assembleSharedContext } from "../domain/translation/promptAssembler";
import { selectRelevantTm } from "../domain/tm/selection";
import { isSweptAccount } from "../domain/sweptAccount";
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
const MAX_TM_FEW_SHOTS = 6;

/**
 * Whether `selector.since` — the translate floor, `HERALD_TRANSLATE_SINCE` — leaves this item alone.
 *
 * The floor exists to stop the *swept timeline's* whole history pouring into translation oldest
 * first. A post someone pasted into 링크 수집 is not that risk: nothing but that tab can put another
 * account's thread in `x_threads` (`src/domain/sweptAccount.ts` states why), so the handle is the
 * marker, and an item authored anywhere but the swept account is a hand-picked one that proceeds
 * whatever its date. The swept account's own posts still meet the floor, because a pre-floor one of
 * those is indistinguishable from swept backlog — `CollectLinkedThread` refuses that at the door
 * instead, so it cannot be collected and then silently dropped here.
 *
 * **An unreadable author keeps the floor.** A Lark item has no handle, and neither does an X thread
 * stored with no tweets; reading "unknown" as "not the swept account" would open the entire
 * historical backlog on the next tick. Shut, the worst case is the behaviour that shipped before
 * this rule existed.
 */
function bypassesFloor(item: ContentItem): boolean {
  return item.author !== undefined && item.author !== "" && !isSweptAccount(item.author);
}

export class PrepareTranslations {
  constructor(
    private readonly source: ContentSource,
    private readonly glossaryStore: GlossaryStore,
    private readonly fewShotStore: FewShotStore,
    private readonly config: TranslationConfig,
    private readonly translationStore: TranslationStore,
    private readonly tmStore: FewShotStore,
    private readonly role: string = DEFAULT_ROLE,
  ) {}

  async run(selector: Selector): Promise<{ worksheet: string; pending: ContentItem[] }> {
    const translatedIds = await this.translationStore.listTranslatedIds();
    let pending = await this.source.loadPending(translatedIds);
    pending = this.applySelector(pending, selector);

    const [glossary, styleGuide, locale, fewShots, tm] = await Promise.all([
      this.glossaryStore.load(),
      this.config.loadStyleGuide(),
      this.config.loadLocale(),
      this.fewShotStore.load(),
      this.tmStore.load(),
    ]);

    const header = assembleSharedContext({
      role: this.role,
      glossary,
      styleGuide,
      locale,
      fewShots: [...fewShots.slice(-MAX_FEW_SHOTS), ...selectRelevantTm(pending, tm, MAX_TM_FEW_SHOTS)],
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
      result = result.filter((i) => i.createdAt >= since || bypassesFloor(i));
    }
    const limit = selector.limit ?? DEFAULT_LIMIT;
    return result.slice(0, limit);
  }
}
