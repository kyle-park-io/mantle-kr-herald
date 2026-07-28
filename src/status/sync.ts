import { contentHash, isStale, type SyncEntry } from "../domain/publish/syncLedger";

/**
 * Three mutually-exclusive states per item, relative to its CURRENT status:
 * - `synced`         — every ledger row is at the current status and matches the current render.
 * - `needsRepublish` — the item was published, but the live files are outdated: a status change
 *                      (published as review, then approved) or an edit since the last upload.
 * - `unpublished`    — no ledger row at all.
 */
export interface SyncCounts {
  synced: number;
  needsRepublish: number;
  unpublished: number;
}

interface Publishable {
  itemId: string;
  status: string;
}

/**
 * `render` produces exactly the bytes the uploader would send, so the hash comparison detects
 * "approved, then edited, but Drive still holds the old version" as well as a plain status change.
 */
export function syncSummary<T extends Publishable>(input: {
  translations: T[];
  entries: SyncEntry[];
  render: (t: T) => string;
}): SyncCounts {
  let synced = 0;
  let needsRepublish = 0;
  let unpublished = 0;

  for (const t of input.translations) {
    const mine = input.entries.filter((e) => e.itemId === t.itemId);
    if (mine.length === 0) {
      unpublished += 1;
      continue;
    }
    const current = contentHash(input.render(t));
    // Synced only when NOTHING is out of date: every row is at the current status and current hash.
    // A wrong-status leftover (e.g. the review doc after approval) or a stale hash flips it.
    const fullySynced = mine.every((e) => e.status === t.status && !isStale(e, current));
    if (fullySynced) synced += 1;
    else needsRepublish += 1;
  }

  return { synced, needsRepublish, unpublished };
}

export function formatSyncSummary(s: SyncCounts): string {
  const parts = [`${s.synced} synced`];
  if (s.needsRepublish > 0) parts.push(`${s.needsRepublish} need republish`);
  if (s.unpublished > 0) parts.push(`${s.unpublished} unpublished`);
  const warn = s.needsRepublish > 0 || s.unpublished > 0 ? "⚠ " : "";
  return `${warn}sync: ${parts.join(" · ")}`;
}
