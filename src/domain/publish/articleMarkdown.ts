/**
 * Rewrite an article translation's inline images to X Article media embeds. Each `![](<url>)` whose
 * url has an uploaded media_id becomes `<typ:media media_id="<id>" />` (block-level, as X Article
 * requires); an image with no mapped id is left untouched (the caller uploads all images first).
 * Pure — the `#`-title/`##`-heading/body markdown is otherwise unchanged.
 */
export function toXArticleMarkdown(koreanText: string, mediaIdByUrl: Map<string, string>): string {
  return koreanText.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (whole, url: string) => {
    const id = mediaIdByUrl.get(url);
    return id ? `<typ:media media_id="${id}" />` : whole;
  });
}
