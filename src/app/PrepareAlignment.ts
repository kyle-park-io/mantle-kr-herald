import type { TranslationStore } from "../ports/TranslationStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { Translation } from "../domain/translation/models";
import type { Selector } from "./PrepareTranslations";
import { selectPrecedents } from "../domain/tm/selection";
import { assembleAlignmentWorksheet, type AlignmentBlock } from "../domain/translation/alignmentWorksheet";

const DEFAULT_LIMIT = 20;
const PRECEDENTS_PER_DRAFT = 3;

export interface PrepareAlignmentResult {
  worksheet: string;
  aligned: number;
  skipped: number;
}

export class PrepareAlignment {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly tmStore: FewShotStore,
  ) {}

  async run(selector: Selector): Promise<PrepareAlignmentResult> {
    const drafts = this.applySelector(
      (await this.translationStore.loadAll()).filter((t) => t.status === "translated"),
      selector,
    );
    const tm = await this.tmStore.load();

    const blocks: AlignmentBlock[] = [];
    let skipped = 0;
    for (const d of drafts) {
      const precedents = selectPrecedents(d.sourceText, tm, PRECEDENTS_PER_DRAFT);
      if (precedents.length === 0) {
        skipped += 1;
        continue;
      }
      blocks.push({ itemId: d.itemId, sourceText: d.sourceText, draftKorean: d.koreanText, precedents });
    }

    return { worksheet: assembleAlignmentWorksheet(blocks), aligned: blocks.length, skipped };
  }

  private applySelector(drafts: Translation[], selector: Selector): Translation[] {
    let result = drafts;
    if (selector.ids && selector.ids.length > 0) {
      const wanted = new Set(selector.ids);
      result = result.filter((t) => wanted.has(t.itemId));
    }
    if (selector.since) {
      const since = selector.since;
      result = result.filter((t) => t.translatedAt >= since);
    }
    const limit = selector.limit ?? DEFAULT_LIMIT;
    return result.slice(0, limit);
  }
}
