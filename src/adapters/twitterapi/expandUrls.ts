export interface UrlEntity {
  url?: string | null;
  expanded_url?: string | null;
}

/**
 * Turn a tweet's raw `text` into readable links:
 *  1. replace each `t.co` shortlink with its real `expanded_url` (from entities.urls), and
 *  2. strip any `t.co` still present — those are the tweet's own photo/video attachments, which
 *     Twitter encodes into the text but are not links (they are carried on SourceTweet.media).
 * String replacement (t.co tokens are unique) avoids the indices field's code-unit ambiguity.
 * See docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md.
 */
export function expandUrls(text: string, urls?: UrlEntity[]): string {
  let out = text;
  for (const u of urls ?? []) {
    if (u.url && u.expanded_url) out = out.split(u.url).join(u.expanded_url);
  }
  // Whatever t.co remains was not in entities.urls: a media attachment. Remove it with the
  // whitespace that attached it.
  out = out.replace(/\s*https?:\/\/t\.co\/\w+/g, "");
  return out.trim();
}
