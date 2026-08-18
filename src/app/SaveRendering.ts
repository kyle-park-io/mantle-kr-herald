import type { ConversionType } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import type { Channel, ChannelRendering } from "../domain/formatting/models";
import type { FormattingStore } from "../ports/FormattingStore";
import type { LineageStore } from "../ports/LineageStore";
import type { LineageActor } from "../domain/lineage/models";

export interface SaveRenderingInput {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
}

export class SaveRendering {
  constructor(
    private readonly formattingStore: FormattingStore,
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

  async run(input: SaveRenderingInput): Promise<{ itemId: string; type: ConversionType; channel: Channel }> {
    const rendering: ChannelRendering = {
      itemId: input.itemId, type: input.type, channel: input.channel, text: toCanonical(input.text), refined: true, createdAt: this.now(), status: "rendered",
    };
    await this.formattingStore.upsert(rendering);
    if (this.lineage) {
      try {
        await this.lineage.append({ itemId: input.itemId, stage: "rendered", variant: `${input.type}/${input.channel}`, content: rendering.text, status: rendering.status, at: rendering.createdAt, actor: this.actor });
      } catch (err) {
        console.warn(`[lineage] append failed for ${input.itemId}: ${(err as Error).message}`);
      }
    }
    return { itemId: input.itemId, type: input.type, channel: input.channel };
  }
}
