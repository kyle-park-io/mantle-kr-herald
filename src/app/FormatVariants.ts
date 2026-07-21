import { ALL_TYPES, type ConversionType, type ContentVariant } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import { emitAll, type Destination, type EmitResult } from "../domain/formatting/emitters";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering } from "../domain/formatting/models";
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

/** Load the approved variants matching the selector's types + ids. Shared by the §6 use-cases. */
export async function selectApprovedVariants(store: ConversionStore, selector: FormatSelector): Promise<ContentVariant[]> {
  const types = selector.types ?? ALL_TYPES;
  const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
  return (await store.loadAll()).filter(
    (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
  );
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(selector: FormatSelector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const approved = await selectApprovedVariants(this.conversionStore, selector);

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      // The same canonical text is stored for every channel on purpose: it is a common starting
      // point that the writer can then refine per channel, which is what per-channel approval is for.
      const text = toCanonical(v.convertedText);
      for (const channel of channels) {
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text, refined: false, createdAt: this.now(), status: "rendered",
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        // Group by message text so destinations that agree (e.g. x_paste and x_typefully today)
        // collapse to one line, while destinations that legitimately disagree (paste counts
        // markup, bot counts visible length) stay distinguishable by name.
        const byMessage = new Map<string, Destination[]>();
        for (const [destination, result] of Object.entries(emitAll(text, channel)) as [Destination, EmitResult][]) {
          for (const warning of result.warnings) {
            byMessage.set(warning, [...(byMessage.get(warning) ?? []), destination]);
          }
        }
        const messages = [...byMessage].map(([warning, destinations]) => `${destinations.join(", ")}: ${warning}`);
        if (messages.length > 0) warnings.push({ itemId: v.itemId, type: v.type, channel, messages });
      }
    }
    return { renderings, warnings };
  }
}
