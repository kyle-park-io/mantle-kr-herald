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
 * A Telegram handle (no @, 5-32 chars of [A-Za-z0-9_]) parsed from a `kol-map` handle cell, or
 * undefined when the cell is blank, an invite link (`t.me/+...`), a `joinchat` link, or not a
 * Telegram reference at all. Unlike extractXHandle, this takes only the cell — kol-map has a
 * single handle column with no sibling platform column to gate on.
 *
 * All four forms a human plausibly types are accepted, because the paste table in
 * `docs/ko/kol-map-seed.md` lists **bare** handles while the spec's examples are full URLs:
 *
 *   https://t.me/marshallog   t.me/marshallog   @marshallog   marshallog
 *
 * Accepting only some of them made the whole feature inert without a single warning: every row
 * was dropped and the run still printed a clean `0 created`.
 */
export function extractTelegramHandle(link: string): string | undefined {
  const s = (link ?? "").trim();
  if (s === "") return undefined;
  // The protocol is optional so a cell reading `t.me/<handle>` — what a human gets by copying the
  // visible text of a link rather than its target — resolves too.
  const url = /^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]{5,32})(?=$|[/?#])/i.exec(s);
  if (url) return usableHandle(url[1]);
  const bare = /^@?([A-Za-z0-9_]{5,32})$/.exec(s);
  if (bare) return usableHandle(bare[1]);
  return undefined;
}

/**
 * `undefined` for a word that satisfies the character rule but is never a channel handle.
 *
 * `joinchat` is the trap here: it is a path segment of an invite link, and at 8 characters it
 * satisfies the 5-32 bare-handle rule exactly, so widening the bare form above would otherwise
 * turn `t.me/joinchat/AAAA` (and a bare `joinchat`) into a sweep of a channel that does not exist.
 */
function usableHandle(handle: string): string | undefined {
  return /^joinchat$/i.test(handle) ? undefined : handle;
}
