import type { DraftState } from "../domain/send/draftState";

/**
 * Reconciliation and quota-recovery both need to ask Typefully about a draft it created — whether it
 * has gone live, and (Task 5) whether a stuck one can be cancelled to give the monthly quota back.
 * One port so both use-cases depend on the same contract instead of an adapter-shaped one each.
 */
export interface DraftLookup {
  /** Looks up a draft's current state — published, still queued, or deleted and never publishing. */
  published(draftId: string): Promise<DraftState>;
  /** Cancels a still-scheduled draft, returning whether it was cancelled. Implemented in Task 5. */
  cancel(draftId: string): Promise<boolean>;
}
