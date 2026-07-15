import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { formatForChannel } from "../domain/formatting/channelFormat";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type FormatOptions } from "../domain/formatting/models";
import { assembleRefinementWorksheet, type RefinementDraft } from "../domain/formatting/refinementWorksheet";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormatSelector } from "./FormatVariants";

export interface PendingRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class PrepareRefinements {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly opts: FormatOptions = {},
  ) {}

  async run(selector: FormatSelector): Promise<{ worksheet: string; pending: PendingRendering[] }> {
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
    const approved = (await this.conversionStore.loadAll()).filter(
      (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
    );

    const drafts: RefinementDraft[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      for (const channel of channels) {
        drafts.push({ itemId: v.itemId, type: v.type, channel, draft: formatForChannel(v.convertedText, channel, this.opts).text });
      }
    }

    const worksheet = assembleRefinementWorksheet(drafts);
    const pending = drafts.map((d) => ({ itemId: d.itemId, type: d.type, channel: d.channel }));
    return { worksheet, pending };
  }
}
