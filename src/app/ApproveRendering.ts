import type { ConversionType } from "../domain/conversion/models";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FewShotStore } from "../ports/FewShotStore";
import type { FormattingStore } from "../ports/FormattingStore";
import type { LineageStore } from "../ports/LineageStore";

export interface ApproveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

/**
 * 2차 검수 — the one human gate on copy that goes out. Approving here also promotes the variant
 * behind this rendering into its type's few-shot corpus, because this is the only point in the
 * pipeline where a person has actually read the converted copy.
 *
 * `conversionStore` and `fewShotByType` are required, not optional like `lineage`: a construction
 * site that forgot them would silently stop the flywheel growing, with every test still green.
 */
export class ApproveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
    private readonly conversionStore: ConversionStore,
    private readonly fewShotByType: Record<ConversionType, FewShotStore>,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lineage?: LineageStore,
  ) {}

  async run(input: ApproveRenderingInput): Promise<ChannelRendering | undefined> {
    const all = await this.formattingStore.loadAll();
    const existing = all.find((r) => r.itemId === input.itemId && r.type === input.type && r.channel === input.channel);
    if (!existing) return undefined;
    const approved: ChannelRendering = { ...existing, status: "approved", approvedAt: this.now() };
    await this.formattingStore.upsert(approved);
    await this.promoteVariant(input, approved.approvedAt!);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "rendered", variant: `${input.type}/${input.channel}`, content: approved.text, status: "approved", at: approved.approvedAt! });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    return approved;
  }

  /**
   * Marks the variant approved and adds it to its type's few-shot corpus.
   *
   * The example's target is the variant's `convertedText`, not this rendering's text: few-shot
   * steers the *conversion* step, whose output is the variant, and a type can have several channel
   * renderings — keying off one of them would make the stored example depend on which channel the
   * reviewer happened to approve first. The cost is that a per-channel edit made in 2차 does not
   * flow back into the corpus (which was already true when promotion lived in `convert:save`).
   *
   * `FewShotStore.add` upserts by `itemId`, so approving a second channel of the same type re-writes
   * the same entry rather than duplicating it.
   */
  private async promoteVariant(input: ApproveRenderingInput, at: string): Promise<void> {
    const variant = (await this.conversionStore.loadAll()).find((v) => v.itemId === input.itemId && v.type === input.type);
    if (!variant) return; // A rendering with no variant behind it: approve it, but there is nothing to teach.
    await this.conversionStore.upsert({ ...variant, status: "approved", approvedAt: variant.approvedAt ?? at });
    await this.fewShotByType[input.type].add({ source: variant.sourceKorean, target: variant.convertedText, itemId: input.itemId });
  }
}
