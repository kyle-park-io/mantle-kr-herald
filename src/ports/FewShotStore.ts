import type { FewShotExample } from "../domain/translation/models";

export interface FewShotStore {
  load(): Promise<FewShotExample[]>;
  /** Upserts by `itemId` when present (idempotent re-approval); otherwise appends. */
  add(ex: FewShotExample): Promise<void>;
}
