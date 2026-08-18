import type { ContentVariant, ConversionType } from "../domain/conversion/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { LineageStore } from "../ports/LineageStore";
import type { LineageActor } from "../domain/lineage/models";

export interface SaveConversionInput {
  itemId: string;
  type: ConversionType;
  sourceKorean: string;
  convertedText: string;
}

/**
 * Stores the agent's converted copy. Always `converted` — a variant is never approved here.
 *
 * The copy an agent writes has had no human eye on it yet, so approving it at save time would both
 * skip the review and feed the unreviewed text straight into the few-shot corpus that steers every
 * later conversion (which is exactly how the corpus once ended up fighting its own style guide).
 * `ApproveRendering` marks the variant approved and promotes it, at 2차, where a human reads it.
 */
export class SaveConversion {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly now: () => string = () => new Date().toISOString(),
    // Was `lineage?: LineageStore` — dropped to `| undefined` so `actor` below can be required: TS
    // refuses a required parameter after an optional (`?`) one, but accepts one after a parameter
    // typed to allow `undefined`. The call-site behaviour is identical either way.
    private readonly lineage: LineageStore | undefined,
    /**
     * Which kind of caller built this — see `LineageActor`. Required rather than defaulted: a new
     * call site that inherits a neighbour's answer would mislabel human edits as machine ones, and
     * nothing downstream could tell. One value per process; no process is sometimes a human.
     */
    private readonly actor: LineageActor,
  ) {}

  async run(input: SaveConversionInput): Promise<{ itemId: string; type: ConversionType }> {
    /**
     * `x` is the approved translation verbatim — `PrepareConversions` writes that row itself and
     * keeps the type out of the worksheet entirely, so nothing should ever arrive here asking to
     * replace it. This is the door that would still be open if it did not refuse:
     * `src/cli/convert-save.ts` falls back to an already-saved variant's `sourceKorean` when the
     * pair is missing from `pending.json`, and the passthrough always leaves one saved. A refusal
     * rather than a silent no-op, because the caller has a file it believes it just wrote.
     */
    if (input.type === "x") {
      throw new Error(
        `Refusing to save an x variant for ${input.itemId}: x goes out as the 1차-approved translation, ` +
          `verbatim — there is nothing to convert. Change the Korean in 1차 검수, or edit this card in 2차 검수.`,
      );
    }
    const timestamp = this.now();
    const variant: ContentVariant = {
      itemId: input.itemId,
      type: input.type,
      sourceKorean: input.sourceKorean,
      convertedText: input.convertedText,
      status: "converted",
      createdAt: timestamp,
    };
    await this.conversionStore.upsert(variant);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "converted", variant: input.type, content: input.convertedText, status: variant.status, at: timestamp, actor: this.actor });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    return { itemId: input.itemId, type: input.type };
  }
}
