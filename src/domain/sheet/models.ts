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
  postId?: string;
  url?: string;
  status: string; // e.g. "posted" | "failed"
  publishedAt: string; // ISO
}

export const TARGETS_HEADER = ["channel", "name", "address", "active", "notes"];
export const HISTORY_HEADER = ["itemId", "type", "channel", "postId", "url", "status", "publishedAt", "impressions", "impressionsAt"];
