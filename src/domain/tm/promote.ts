import type { ProposedRecord } from "./pairsReview";

/** A record is promoted unless the human explicitly set accept:false. */
export function acceptedRecords(records: ProposedRecord[]): ProposedRecord[] {
  return records.filter((r) => r.accept !== false);
}
