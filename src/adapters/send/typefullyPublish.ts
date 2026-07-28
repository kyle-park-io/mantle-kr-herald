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

/** The X article id in `https://x.com/i/article/<id>`. */
export function parseArticleId(url: string | undefined): string | undefined {
  const m = url ? /\/article\/(\d+)/.exec(url) : null;
  return m ? m[1] : undefined;
}
