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
 * A human's `reject` verdict on a `kol-telegram-posts` row: "this is not a deliverable".
 *
 * One definition, shared, because three places act on it and they must agree. `RecordKolTelegramPosts`
 * refuses to refresh a rejected row and refuses it as a source of an inherited topic; `SweepKolQuarter`
 * must additionally keep it out of the monthly log and out of the contract count, or the next weekly
 * run writes the rejected post back with a price in `Price per posting` — `Total Cost` bills it, the
 * contract comparison credits it, and a human deleting the log row by hand only gets it re-appended.
 *
 * Exact match on the documented cell value (`KolTelegramRow.confirmed`), which is what
 * `RecordKolTelegramPosts` has always compared: a looser test here would start rejecting rows the
 * sibling still refreshes.
 */
export function isRejected(confirmed: string): boolean {
  return confirmed === "reject";
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

/**
 * The columns `LoadKolMap` reads out of the humans' `KOL list` tab. Four are new (`kolId`,
 * `sheetLabel`, `pricePerPost`, `active`); `Social media link` was already there and empty.
 *
 * `pricePerPost` is separate from the tab's existing `Content Price` on purpose: that column is
 * free text a human negotiates in (`150~180`, `0.01`) and disagrees with this one (Marine is 150
 * there, 100 here) because they measure different things. Merging them would fabricate agreement.
 */
export const KOL_LIST_HEADER = ["kolId", "Social media link", "sheetLabel", "pricePerPost", "active"] as const;
