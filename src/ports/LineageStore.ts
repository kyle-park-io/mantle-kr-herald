import type { LineageEntry, LineageStage } from "../domain/lineage/models";

export interface LineageSummary {
  itemId: string;
  entries: number;
  lastStage: LineageStage;
}

export interface LineageStore {
  append(entry: LineageEntry): Promise<void>;
  load(itemId: string): Promise<LineageEntry[]>;
  listItems(): Promise<LineageSummary[]>;
}
