export interface DistributionTarget {
  channel: string; // telegram | x | pr_mail | kol | … (human-maintained)
  name: string;
  address: string; // chat_id | handle | email
  active: boolean;
  notes?: string;
}

export interface PublishRecord {
  itemId: string;
  type: string; // x | kol | pr
  channel: string; // x | telegram | kakao | pr_mail
  /**
   * The room this went to (`tg-community`, `tg-dev`, …). Part of the row's identity: two rooms
   * share a channel, so a channel-keyed row let 데브방's send overwrite 커뮤니티's postId and url.
   * Optional only for the manual `history:record` CLI and for pre-outlet rows, which have none.
   */
  outletId?: string;
  postId?: string;
  url?: string;
  status: string; // e.g. "posted" | "failed"
  publishedAt: string; // ISO
}

export const TARGETS_HEADER = ["channel", "name", "address", "active", "notes"];
/**
 * `outletId` sits after the impression columns rather than beside `channel` on purpose: H/I are
 * owned by `RecordImpressions` and hold live data on the team's sheet, and inserting a column
 * before them would shift every existing row's impressions on an install that had not yet done the
 * matching manual insert — silently mixing publish values into the impression columns.
 */
export const HISTORY_HEADER = ["itemId", "type", "channel", "postId", "url", "status", "publishedAt", "impressions", "impressionsAt", "outletId"];

export interface RosterEntry {
  name: string;
  handle: string; // X handle without @
}

export const X_PERFORMANCE_HEADER = ["account", "name", "type", "month", "followers", "posts", "views", "engagement", "fetchedAt"];
