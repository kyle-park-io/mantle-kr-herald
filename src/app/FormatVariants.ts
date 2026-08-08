import { ALL_TYPES, type ConversionType, type ContentVariant } from "../domain/conversion/models";
import { stripBold, toCanonical } from "../domain/formatting/canonical";
import { CHANNEL_RENDERS_BOLD, emitAll, type Destination, type EmitResult } from "../domain/formatting/emitters";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering } from "../domain/formatting/models";
import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";
import type { ConversionStore } from "../ports/ConversionStore";
import { renderingKey, type FormattingStore } from "../ports/FormattingStore";

export interface FormatSelector {
  ids?: string[];
  types?: ConversionType[];
  channels?: Channel[];
}

export interface FormatOptions {
  /**
   * Format only the (item, type, channel) pairs that have **no rendering at all** yet, and leave
   * every existing one exactly as it is. Default (`false`) rebuilds and overwrites — see `run`.
   *
   * A separate argument rather than another field on `FormatSelector` because that type is shared
   * with `PrepareRefinements`, which does not and cannot honour this: a selector field that one of
   * its two consumers silently ignores is a flag that appears to work and does nothing.
   */
  onlyMissing?: boolean;
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

  /**
   * Render each selected variant into its channels' canonical text and upsert the result.
   *
   * **By default this overwrites.** Every rendering it emits carries `status: "rendered"`,
   * `refined: false` and text rebuilt from the variant, so a pair that a reviewer edited and
   * approved in 2차 검수 comes back out of here as an unapproved, unedited card. That is deliberate
   * and is what the dashboard's red `[포맷 다시]` button and a hand-run `pnpm format --ids …` are
   * for — the operator is told exactly what is lost and confirms it (`docs/ko/review.md`).
   *
   * `options.onlyMissing` is the mode for callers that are not an operator standing at a
   * confirmation dialog — today, the 30-minute `ConvertTick`. It formats only the pairs with no
   * rendering at all, which is the difference between "the board fills itself" and "the board is
   * wiped twice an hour".
   */
  async run(
    selector: FormatSelector,
    options: FormatOptions = {},
  ): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const variants = await selectVariants(this.conversionStore, selector);
    // Read once for the whole run, before anything is written — and only in this mode, so the
    // default path costs no extra query. Reading it inside the loop would also be wrong, not just
    // slower: this run's own upserts would start appearing in it.
    const alreadyRendered = options.onlyMissing ? await this.formattingStore.listRenderedKeys() : undefined;

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of variants) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      // The same canonical text is stored for every channel on purpose: it is a common starting
      // point that the writer can then refine per channel, which is what per-channel approval is for.
      const canonical = toCanonical(v.convertedText);
      for (const channel of channels) {
        // The skip is per (item, type, channel), not per variant: one `announcement` fans out to
        // telegram and kakao, and a run that skipped the whole variant because telegram was already
        // rendered would leave the kakao card missing for good. The key comes from the port that
        // produced the set — see `renderingKey`'s own comment for what a hand-rolled copy costs.
        if (alreadyRendered?.has(renderingKey({ itemId: v.itemId, type: v.type, channel }))) continue;
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
