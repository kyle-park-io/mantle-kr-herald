import type { OutletOverride } from "../domain/outlet/override";

export interface OutletOverrideStore {
  loadAll(): Promise<OutletOverride[]>;
  upsert(o: OutletOverride): Promise<void>;
  remove(key: string): Promise<void>;
}
