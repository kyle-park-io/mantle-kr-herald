import { ALL_TYPES, type ConversionType, type ContentVariant } from "../domain/conversion/models";
import { stripBold, toCanonical } from "../domain/formatting/canonical";
import { CHANNEL_RENDERS_BOLD, emitAll, type Destination, type EmitResult } from "../domain/formatting/emitters";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering } from "../domain/formatting/models";
import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";
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

/**
 * Load the variants matching the selector's types + ids. Shared by the §6 use-cases.
 *
 * Deliberately NOT filtered on `status`. Formatting is mechanical — it renders a variant into each
 * channel's canonical text and nothing leaves the machine — so gating it on a variant approval only
 * bought a second review of copy the reviewer reads again on the outlet board. The one human gate
 * that matters is 2차: `SendChannels` sends only `approved` *renderings*, and `ApproveRendering` is
 * where a variant earns its way into the few-shot corpus.
 */
export async function selectVariants(store: ConversionStore, selector: FormatSelector): Promise<ContentVariant[]> {
  const types = selector.types ?? ALL_TYPES;
  const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
  return (await store.loadAll()).filter((v) => types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)));
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
  ) {}

  async run(selector: FormatSelector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const variants = await selectVariants(this.conversionStore, selector);

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of variants) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      // The same canonical text is stored for every channel on purpose: it is a common starting
      // point that the writer can then refine per channel, which is what per-channel approval is for.
      const canonical = toCanonical(v.convertedText);
      for (const channel of channels) {
        /**
         * …with one exception: bold markers are dropped for a channel that cannot render them.
         *
         * The decision belongs here, on the channel axis, and NOT back at the variant: `announcement`
         * feeds telegram *and* kakao, so stripping it one step earlier would take the bold off
         * Telegram too, where it is the whole point of the 공지 title convention.
         *
         * Dropping them rather than carrying them inert matters because this text is what the
         * reviewer reads and edits on the board. On kakao a `**제목**` can never do anything: it is
         * noise to read around, and text copied straight out of the editor pastes the asterisks
         * into the room verbatim.
         */
        const text = CHANNEL_RENDERS_BOLD[channel] ? canonical : stripBold(canonical);
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text, refined: false, createdAt: this.now(), status: "rendered",
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        // Group by message text so destinations that agree (e.g. x_paste and x_typefully today)
        // collapse to one line, while destinations that legitimately disagree (paste counts
        // markup, bot counts visible length) stay distinguishable by name.
        const byMessage = new Map<string, Destination[]>();
        for (const [destination, result] of Object.entries(emitAll(text, channel, this.xMaxWeighted)) as [Destination, EmitResult][]) {
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
