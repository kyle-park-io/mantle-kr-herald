import { ALL_TYPES, type ConversionType } from "../domain/conversion/models";
import { formatForChannel } from "../domain/formatting/channelFormat";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering, type FormatOptions } from "../domain/formatting/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormattingStore } from "../ports/FormattingStore";

export interface FormatSelector {
  ids?: string[];
  types?: ConversionType[];
  channels?: Channel[];
}

export interface FormatWarning {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  messages: string[];
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    private readonly opts: FormatOptions = {},
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(selector: FormatSelector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const types = selector.types ?? ALL_TYPES;
    const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
    const approved = (await this.conversionStore.loadAll()).filter(
      (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
    );

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      for (const channel of channels) {
        const result = formatForChannel(v.convertedText, channel, this.opts);
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text: result.text, refined: false, createdAt: this.now(), status: "rendered",
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        if (result.warnings.length > 0) warnings.push({ itemId: v.itemId, type: v.type, channel, messages: result.warnings });
      }
    }
    return { renderings, warnings };
  }
}
