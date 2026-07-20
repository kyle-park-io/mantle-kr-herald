import { contentHash, isStale, type SyncEntry } from "../domain/publish/syncLedger";

export interface SyncCounts {
  published: number;
  unsynced: number;
  stale: number;
}

interface Publishable {
  itemId: string;
  status: string;
}

/**
 * `render` produces exactly the bytes the uploader would send, so the hash comparison detects
 * "approved, then edited, but Drive still holds the old version".
 */
export function syncSummary<T extends Publishable>(input: {
  translations: T[];
  entries: SyncEntry[];
  render: (t: T) => string;
}): SyncCounts {
  let published = 0;
  let unsynced = 0;
  let stale = 0;

  for (const t of input.translations) {
    const matches = input.entries.filter((e) => e.itemId === t.itemId && e.status === t.status);
    if (matches.length === 0) {
      unsynced += 1;
      continue;
    }
    published += 1;
    const current = contentHash(input.render(t));
    if (matches.some((e) => isStale(e, current))) stale += 1;
  }

  return { published, unsynced, stale };
}

export function formatSyncSummary(s: SyncCounts): string {
  const parts = [`${s.published} published`];
  if (s.unsynced > 0) parts.push(`${s.unsynced} unsynced`);
  if (s.stale > 0) parts.push(`${s.stale} stale`);
  const warn = s.unsynced > 0 || s.stale > 0 ? "⚠ " : "";
  return `${warn}sync: ${parts.join(" · ")}`;
}
