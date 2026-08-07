/**
 * Every spelling of a photo marker an article body can carry, as one pattern with the url in group 1.
 *
 * Two spellings, because the two ends of the article pipeline grew apart:
 *
 *   `[사진](url)`  — what `renderArticle` (src/domain/articleMarkdown.ts) writes into an article's
 *                    source text, and what the pipeline's own marker vocabulary uses everywhere
 *                    else (`PHOTO_LINE`, src/domain/media/sourceMedia.ts, reads both spellings and
 *                    has since the label was introduced).
 *   `![alt](url)`  — ordinary markdown, which is all this file matched until 2026-08-07.
 *
 * Matching only the second one meant an article's images reached X only when the translating agent
 * happened to rewrite `[사진]` into `![]` on the way through. Measured that day against production:
 * it rewrote 8 of 8 photo markers in one batch and preserved all 4 in the batches before, so which
 * behaviour you got was a coin flip, and losing the flip published an article with no images and no
 * error — `mediaIdByUrl` would simply be empty and every marker left as-is.
 *
 * `[사진]` is spelled out rather than accepting any `[label](url)`: a photo marker is a markdown
 * link by shape, and a body's ordinary links (`[문서](https://docs.mantle.xyz)`) must survive
 * untouched. Exported so `SendXArticle`'s upload pass and this file's rewrite pass cannot drift onto
 * different patterns — uploading a url this function will not embed silently burns a `media/upload`
 * call against a 20/hour ceiling, and embedding one that was never uploaded posts a broken article.
 *
 * Safe to share despite the `g` flag: `replace` resets `lastIndex`, and `matchAll` iterates a clone.
 */
export const ARTICLE_IMAGE = /(?:!\[[^\]]*\]|\[사진\])\(([^)]+)\)/g;

/**
 * Rewrite an article translation's inline images to X Article media embeds. Each marker (see
 * `ARTICLE_IMAGE`) whose url has an uploaded media_id becomes `<typ:media media_id="<id>" />`
 * (block-level, as X Article requires); an image with no mapped id is left untouched (the caller
 * uploads all images first). Pure — the `#`-title/`##`-heading/body markdown is otherwise unchanged.
 */
export function toXArticleMarkdown(koreanText: string, mediaIdByUrl: Map<string, string>): string {
  return koreanText.replace(ARTICLE_IMAGE, (whole, url: string) => {
    const id = mediaIdByUrl.get(url);
    return id ? `<typ:media media_id="${id}" />` : whole;
  });
}
