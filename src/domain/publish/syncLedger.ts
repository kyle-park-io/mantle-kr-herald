import { createHash } from "node:crypto";

/**
 * One row per (itemId, status, target). Fields after `target` are optional because entries
 * migrated from the legacy `{published: string[]}` format genuinely do not know them —
 * recording a placeholder would make a migrated row indistinguishable from a real upload.
 */
export interface SyncEntry {
  itemId: string;
  stage: "translation";
  status: string;
  target: string;
  fileName?: string;
  remoteId?: string;
  url?: string;
  contentHash?: string;
  uploadedAt?: string;
}

export function entryKey(e: Pick<SyncEntry, "itemId" | "status" | "target">): string {
  return `${e.itemId}:${e.status}:${e.target}`;
}

export function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Legacy keys are `<itemId>:<status>:<target>`, and itemId contains a colon of its own
 * ("x:1934"), so split from the right and treat everything left of the last two parts as the id.
 */
export function migrateLegacyKeys(keys: string[]): SyncEntry[] {
  const entries: SyncEntry[] = [];
  for (const key of keys) {
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const target = parts[parts.length - 1];
    const status = parts[parts.length - 2];
    const itemId = parts.slice(0, -2).join(":");
    if (!itemId || !status || !target) continue;
    entries.push({ itemId, stage: "translation", status, target });
  }
  return entries;
}

/** A migrated entry has no hash — unknown is not the same as changed, so it is not stale. */
export function isStale(entry: SyncEntry, currentHash: string): boolean {
  return entry.contentHash !== undefined && entry.contentHash !== currentHash;
}
