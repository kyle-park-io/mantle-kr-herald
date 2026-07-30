// src/domain/metrics/handles.ts

/** An X handle (no @, ≤15 chars) when this roster row is an X account, else undefined. */
export function extractXHandle(platform: string, link: string): string | undefined {
  if (!/^\s*(x|twitter)\s*$/i.test(platform)) return undefined;
  const s = (link ?? "").trim();
  if (s === "") return undefined;
  const url = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?=$|[/?#])/i.exec(s);
  if (url) return url[1];
  const bare = /^@?([A-Za-z0-9_]{1,15})$/.exec(s);
  if (bare) return bare[1];
  return undefined;
}

/**
 * A Telegram handle (no @, 5-32 chars of [A-Za-z0-9_]) parsed from a `kol-map` link cell, or
 * undefined when the cell is blank, an invite link (`t.me/+...`), a `joinchat` link, or not a
 * Telegram link at all. Unlike extractXHandle, this takes only the link — kol-map has a single
 * handle column with no sibling platform column to gate on.
 */
export function extractTelegramHandle(link: string): string | undefined {
  const s = (link ?? "").trim();
  if (s === "") return undefined;
  const url = /^https?:\/\/(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]{5,32})(?=$|[/?#])/i.exec(s);
  if (url && !/^joinchat$/i.test(url[1])) return url[1];
  const bare = /^@([A-Za-z0-9_]{5,32})$/.exec(s);
  if (bare) return bare[1];
  return undefined;
}
