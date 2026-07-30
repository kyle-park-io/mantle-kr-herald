import type { ChannelPost } from "../../domain/kol/models";
import type { FetchPostsInWindowResult, TelegramChannelGateway } from "../../ports/TelegramChannelGateway";
import { countMessageBlocks, parseChannelPreview } from "./parseChannelPreview";

export type FetchText = (url: string) => Promise<string>;

/**
 * 50, for parity with the X gateway's cap rather than the 20 this started at.
 *
 * 20 pages x 20 posts/page reached only 400 posts, and the live dry-run measured **236 posts in one
 * month** for a single channel. A re-run of `--month 2026-07` in September has to page through
 * August just to *reach* July, so 20 pages could not get there at all and the retroactive
 * attribution both `docs/ko/capabilities.md` and `docs/ko/team-runbook.md` promise would silently
 * not happen. Truncation is still reported per channel, so an operator can see when even 50 is not
 * enough instead of guessing.
 */
const DEFAULT_MAX_PAGES = 50;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * A channel whose preview page could not be read at all — the operational definition of spec §7's
 * "unreachable": **the page contained no message blocks whatsoever**, not merely "the HTTP call
 * failed".
 *
 * The HTTP throw is not enough on its own. A deleted, renamed, or preview-disabled handle answers
 * `GET https://t.me/s/<handle>` with **302** to `https://t.me/<handle>`; `fetch` follows redirects
 * by default and that contact page is a clean **HTTP 200**. Verified live on 2026-07-30 against a
 * non-existent handle. So `res.ok` was true, the parser returned `[]`, and the sweep took its
 * "nothing left to page through" exit — reporting a dead channel as swept clean, which reads as
 * "this KOL posted nothing about Mantle this month" and quietly under-counts a deliverable.
 *
 * Thrown rather than returned so it lands in the caller's existing per-channel isolation, which
 * already warns naming the channel and counts it as failed.
 */
export class ChannelUnreadableError extends Error {
  constructor(readonly handle: string, url: string) {
    super(
      `no message blocks on ${url} — the channel is deleted, renamed, or has its public preview ` +
        `disabled (t.me answers 302 -> a HTTP 200 contact page for these, so this is not an HTTP error)`,
    );
    this.name = "ChannelUnreadableError";
  }
}

/**
 * Sweeps a public Telegram channel preview (`https://t.me/s/<handle>`) for posts inside a month
 * window. There is no official API for this page, so coverage comes from paging backwards with
 * `?before=<messageId>` until one of three stops is hit: an empty page, a page whose oldest post
 * predates `startISO`, or `maxPages` (the guard against a channel that posts hundreds of times a
 * month). All three are required — the first two are the normal exits, and only the third is
 * reported back as `truncated: true` (see `TelegramChannelGateway`): it means the sweep gave up
 * before covering the month, not that the channel simply posted less.
 */
export class TmePreviewGateway implements TelegramChannelGateway {
  private readonly fetchText: FetchText;
  private readonly maxPages: number;

  constructor(fetchText: FetchText = defaultFetchText, maxPages: number = DEFAULT_MAX_PAGES) {
    this.fetchText = fetchText;
    this.maxPages = maxPages;
  }

  async fetchPostsInWindow(
    handle: string,
    startISO: string,
    endExclusiveISO: string,
  ): Promise<FetchPostsInWindowResult> {
    const base = `https://t.me/s/${handle}`;
    // Keyed by messageId: overlapping pages can repeat a post, and a duplicated row would become
    // a duplicated deliverable downstream.
    const collected = new Map<number, ChannelPost>();
    let url = base;
    // Starts true and is cleared the instant either normal exit fires. If the loop runs out of
    // pages before either of those `break`s executes, this is the only value left standing — so it
    // is true if and only if the `maxPages` cap, not the data, ended the sweep.
    let truncated = true;

    for (let page = 0; page < this.maxPages; page++) {
      const html = await this.fetchText(url);
      // Checked on the first page only: a live channel's newest page always carries message
      // blocks, whereas on a later page "no blocks" is the ordinary end of the archive.
      if (page === 0 && countMessageBlocks(html) === 0) throw new ChannelUnreadableError(handle, url);
      const posts = parseChannelPreview(html, handle);
      if (posts.length === 0) {
        truncated = false; // nothing left to page through
        break;
      }

      let lowestId = posts[0].messageId;
      let oldestPostedAt = posts[0].postedAt;
      for (const post of posts) {
        if (post.messageId < lowestId) lowestId = post.messageId;
        if (post.postedAt < oldestPostedAt) oldestPostedAt = post.postedAt;
        if (post.postedAt >= startISO && post.postedAt < endExclusiveISO) {
          collected.set(post.messageId, post);
        }
      }

      if (oldestPostedAt < startISO) {
        truncated = false; // paged past the window start
        break;
      }

      url = `${base}?before=${lowestId}`;
    }

    return {
      posts: [...collected.values()].sort((a, b) => a.postedAt.localeCompare(b.postedAt)),
      truncated,
    };
  }
}

/**
 * Real network call for `FetchText`, used whenever a gateway is constructed without one.
 * Mirrors `HttpClient`'s retry policy (429/5xx, three attempts, exponential backoff) but returns
 * text instead of JSON, since t.me serves HTML rather than an API response. Kept local to this
 * file rather than folded into `HttpClient`, which is JSON-only and shared by other adapters.
 */
async function defaultFetchText(url: string): Promise<string> {
  const MAX_ATTEMPTS = 3;
  const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));

  let lastError: unknown;
  let lastStatus = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    } catch (err) {
      // Network-level failure (DNS, reset, timeout) — retry like a 5xx.
      lastError = err;
      if (attempt < MAX_ATTEMPTS - 1) await backoff(attempt);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      lastError = undefined;
      if (attempt < MAX_ATTEMPTS - 1) await backoff(attempt);
      continue;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    return res.text();
  }

  if (lastError) {
    throw new Error(`Request failed after ${MAX_ATTEMPTS} attempts (network error): GET ${url}`, {
      cause: lastError,
    });
  }
  throw new Error(`HTTP ${lastStatus}`);
}
