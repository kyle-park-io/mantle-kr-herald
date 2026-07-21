import type { CollectionRun } from "../domain/coverage";

/** Append-only log of collection runs (what range each run covered). */
export interface CollectionRunLedger {
  record(run: CollectionRun): Promise<void>;
}
