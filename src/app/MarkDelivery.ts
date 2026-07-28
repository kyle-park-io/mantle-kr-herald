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
 * Ticks or unticks 전달함 for a manual room. Only `delivered` rows are reversible — a `sent` row
 * records that a bot actually posted, and unticking it would invite a duplicate live post on the
 * next run.
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
