// src/domain/metrics/handles.ts

/** An X handle (no @, ≤15 chars) when this roster row is an X account, else undefined. */
export function extractXHandle(platform: string, link: string): string | undefined {
  if (!/^\s*(x|twitter)\s*$/i.test(platform)) return undefined;
  const s = (link ?? "").trim();
  if (s === "") return undefined;
  const url = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i.exec(s);
  if (url) return url[1];
  const bare = /^@?([A-Za-z0-9_]{1,15})$/.exec(s);
  if (bare) return bare[1];
  return undefined;
}
