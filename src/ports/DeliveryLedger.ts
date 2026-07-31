import type { DeliveryEntry } from "../domain/delivery/models";

export interface DeliveryLedger {
  loadAll(): Promise<DeliveryEntry[]>;
  loadKeys(): Promise<Set<string>>;
  add(entry: DeliveryEntry): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Moves the ledger from holding `previous` to holding `next` as one unit, so a caller composing
   * "take this row out, then put a row back" never has to call `remove()` and `add()` as two
   * separate operations with a gap between them. `PgDeliveryLedger` runs both halves inside one
   * `Db.tx`, so no other connection's read ever lands in that gap; `JsonDeliveryLedger` runs both
   * halves as one read-modify-write, so no other call on the same instance can either.
   *
   * `previous` and `next` usually share a key (`deliveryKey`) — a resend's restore only ever changes
   * a row's status or metadata, never its `itemId`/`type`/`outletId` — but nothing here requires
   * that: `previous`'s key is what gets removed, `next`'s key is what gets written, and those are
   * free to differ.
   */
  replace(previous: DeliveryEntry, next: DeliveryEntry): Promise<void>;
}
