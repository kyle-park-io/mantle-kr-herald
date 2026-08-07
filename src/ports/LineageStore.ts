import type { LineageEntry, LineageEvent, LineageStage } from "../domain/lineage/models";

export interface LineageSummary {
  itemId: string;
  entries: number;
  lastStage: LineageStage;
}

export interface LineageStore {
  append(entry: LineageEntry): Promise<void>;
  load(itemId: string): Promise<LineageEntry[]>;
  listItems(): Promise<LineageSummary[]>;
  /**
   * Every row in the store, projected to `LineageEvent` — the whole table without its text.
   *
   * Deliberately not `loadAll(): LineageEntry[]`. Its one caller (`pnpm lineage --activity`, via
   * `lineageActivity`) counts rows by date and stage and reads no content at all, and a lineage row
   * holds every version of every item's copy — an X Article body alone runs to five figures of
   * characters. `LineageEvent` lets an implementation leave all of that in the database.
   *
   * Order is unspecified. `lineageActivity` groups and sorts by date, so an implementation may
   * return rows in whatever order is cheapest for it; nothing may depend on this order.
   */
  listEvents(): Promise<LineageEvent[]>;
}
