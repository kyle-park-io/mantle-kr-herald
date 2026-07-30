import type { ChannelPost } from "../../domain/kol/models";
import type { TelegramChannelGateway } from "../../ports/TelegramChannelGateway";
import { parseChannelPreview } from "./parseChannelPreview";

export type FetchText = (url: string) => Promise<string>;

const DEFAULT_MAX_PAGES = 20;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Sweeps a public Telegram channel preview (`https://t.me/s/<handle>`) for posts inside a month
 * window. There is no official API for this page, so coverage comes from paging backwards with
 * `?before=<messageId>` until one of three stops is hit: an empty page, a page whose oldest post
 * predates `startISO`, or `maxPages` (the guard against a channel that posts hundreds of times a
 * month). All three are required — the first two are the normal exits.
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
  ): Promise<ChannelPost[]> {
    const base = `https://t.me/s/${handle}`;
    // Keyed by messageId: overlapping pages can repeat a post, and a duplicated row would become
    // a duplicated deliverable downstream.
    const collected = new Map<number, ChannelPost>();
    let url = base;

    for (let page = 0; page < this.maxPages; page++) {
      const html = await this.fetchText(url);
      const posts = parseChannelPreview(html, handle);
      if (posts.length === 0) break; // nothing left to page through

      let lowestId = posts[0].messageId;
      let oldestPostedAt = posts[0].postedAt;
      for (const post of posts) {
        if (post.messageId < lowestId) lowestId = post.messageId;
        if (post.postedAt < oldestPostedAt) oldestPostedAt = post.postedAt;
        if (post.postedAt >= startISO && post.postedAt < endExclusiveISO) {
          collected.set(post.messageId, post);
        }
      }

      if (oldestPostedAt < startISO) break; // paged past the window start

      url = `${base}?before=${lowestId}`;
    }

    return [...collected.values()].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
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
