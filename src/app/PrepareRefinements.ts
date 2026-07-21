import type { ConversionType } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel } from "../domain/formatting/models";
import { assembleRefinementWorksheet, type RefinementDraft } from "../domain/formatting/refinementWorksheet";
import type { ConversionStore } from "../ports/ConversionStore";
import { selectApprovedVariants, type FormatSelector } from "./FormatVariants";

export interface PendingRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class PrepareRefinements {
  constructor(private readonly conversionStore: ConversionStore) {}

  async run(selector: FormatSelector): Promise<{ worksheet: string; pending: PendingRendering[] }> {
    const approved = await selectApprovedVariants(this.conversionStore, selector);

    const drafts: RefinementDraft[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      const draft = toCanonical(v.convertedText);
      for (const channel of channels) {
        drafts.push({ itemId: v.itemId, type: v.type, channel, draft });
      }
    }

    const worksheet = assembleRefinementWorksheet(drafts);
    const pending = drafts.map((d) => ({ itemId: d.itemId, type: d.type, channel: d.channel }));
    return { worksheet, pending };
  }
}
