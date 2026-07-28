import type { DeliveryEntry } from "../domain/delivery/models";

export interface DeliveryLedger {
  loadAll(): Promise<DeliveryEntry[]>;
  loadKeys(): Promise<Set<string>>;
  add(entry: DeliveryEntry): Promise<void>;
  remove(key: string): Promise<void>;
}
