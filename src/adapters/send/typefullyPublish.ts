/**
 * Typefully's direct publish (`publish_at:"now"`) is blocked by X for any tweet/article containing a
 * URL ("Direct publishing of X drafts containing URLs is blocked"). A near-future scheduled time
 * routes through Typefully's queue (the user's session), which allows URLs. 2 minutes is comfortably
 * "scheduled" while still going live promptly.
 */
export const PUBLISH_DELAY_MS = 2 * 60 * 1000;

export function scheduledPublishAt(now: () => number): string {
  return new Date(now() + PUBLISH_DELAY_MS).toISOString();
}

/** The X tweet id in `https://x.com/…/status/<id>` (used when reconciling a published draft). */
export function parseTweetId(url: string | undefined): string | undefined {
  const m = url ? /\/status\/(\d+)/.exec(url) : null;
  return m ? m[1] : undefined;
}

/**
 * The X article id in a published article url.
 *
 * Typefully returns `https://x.com/<handle>/status/<id>` for `x_article_published_url` — the same
 * shape as a tweet url, not the `https://x.com/i/article/<id>` this used to assume. Both are
 * accepted: the `/i/article/` form is what X shows in a browser, and a draft reconciled before this
 * fix may still carry one. `parseTweetId` matches the same `/status/` pattern, but the two read
 * different fields (`x_published_url` vs `x_article_published_url`), so there is nothing to confuse.
 */
export function parseArticleId(url: string | undefined): string | undefined {
  const m = url ? /\/(?:i\/article|status)\/(\d+)/.exec(url) : null;
  return m ? m[1] : undefined;
}
