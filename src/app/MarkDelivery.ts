import { deliveryKey } from "../domain/delivery/models";
import { outletById } from "../domain/outlet/models";
import type { DeliveryLedger } from "../ports/DeliveryLedger";

export interface MarkDeliveryInput {
  itemId: string;
  type: string;
  outletId: string;
  delivered: boolean;
}

/**
 * Ticks or unticks 전달함. Ticking (`delivered: true`) is only accepted for a `delivery: "manual"`
 * outlet — an auto room is delivered by `send:channels`, which gates purely on ledger membership,
 * so a `delivered` row planted on an auto outlet would make it look already-sent and the bot would
 * silently skip it. Unticking (`delivered: false`) is allowed on any outlet, manual or auto, so a
 * bad `delivered` row can always be cleaned up — except a `sent` row is never reversible, since it
 * records that a bot actually posted and unticking it would invite a duplicate live post.
 */
export class MarkDelivery {
  constructor(
    private readonly ledger: DeliveryLedger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: MarkDeliveryInput): Promise<void> {
    const outlet = outletById(input.outletId);
    if (!outlet) throw new Error(`unknown outlet: ${input.outletId}`);

    const key = deliveryKey(input);
    if (!input.delivered) {
      const existing = (await this.ledger.loadAll()).find((e) => deliveryKey(e) === key);
      if (existing?.status === "sent") {
        throw new Error(`${key} was sent by ${existing.senderName ?? "a bot"} and cannot be unmarked`);
      }
      await this.ledger.remove(key);
      return;
    }

    if (outlet.delivery !== "manual") {
      throw new Error(`${outlet.label} (${outlet.id}) is an auto room — it is delivered by send:channels, not marked manually`);
    }

    await this.ledger.add({
      itemId: input.itemId,
      type: input.type,
      outletId: input.outletId,
      status: "delivered",
      by: "manual",
      at: this.now(),
    });
  }
}
