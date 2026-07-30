// src/domain/kol/models.ts

/** One Mantle-mentioning post pulled from a KOL's public Telegram channel. */
export interface ChannelPost {
  handle: string;
  messageId: number;
  url: string; // https://t.me/<handle>/<messageId>
  postedAt: string; // ISO 8601, e.g. "2026-07-03T09:14:45.000Z"
  views: number;
  reactions: { emoji: string; count: number }[];
  text: string; // "" when the post has no text (photo-only)
}

/** One row of the human-maintained `kol-map` tab: which KOLs to sweep and what to pay them. */
export interface KolMapEntry {
  kolId: string;
  tgHandle: string;
  sheetLabel: string;
  pricePerPost: number;
  active: boolean;
}

/** One row of the machine-owned `kol-telegram-posts` tab. */
export interface KolTelegramRow {
  kolId: string;
  tgHandle: string;
  postedAt: string;
  deliverableLink: string;
  views: number;
  engagements: number;
  reactionsDetail: string;
  itemId: string;
  topic: string;
  matchScore: string; // "" or a 2-decimal string, e.g. "0.42"
  pricePerPost: string;
  fetchedAt: string;
  confirmed: string; // "" | "paid" | "organic" | "reject"
}

/**
 * Column order for the `kol-telegram-posts` tab (A-M). This is the single source of truth for
 * where each field lives; nothing else may hardcode a column letter derived from it. Later tasks
 * (the sheet writer, the upsert-by-deliverableLink matcher) index into rows by position, so
 * reordering this array silently reshuffles every column those tasks read and write.
 */
export const KOL_TELEGRAM_HEADER: string[] = [
  "kolId", "tgHandle", "postedAt", "deliverableLink", "views", "engagements",
  "reactionsDetail", "itemId", "topic", "matchScore", "pricePerPost", "fetchedAt", "confirmed",
];

/** Column order for the human-maintained `kol-map` tab (A-E). Same load-bearing rule as above. */
export const KOL_MAP_HEADER: string[] = ["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"];
