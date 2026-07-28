import type { ChannelSentEntry } from "../domain/send/channels";

/** Published X url(s) + parsed ids for a Typefully draft, as returned by `TypefullyDraftLookup`. */
interface Published {
  xUrl?: string;
  xId?: string;
  articleUrl?: string;
  articleId?: string;
}
interface Lookup {
  published(draftId: string): Promise<Published>;
}
interface ChannelLedger {
  loadAll(): Promise<ChannelSentEntry[]>;
  add(entry: ChannelSentEntry): Promise<void>;
}
interface ArticleRow {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
}
interface ArticleLedger {
  loadAll(): Promise<ArticleRow[]>;
  add(entry: ArticleRow): Promise<void>;
}

/** A row already carries its final x.com url once reconciled — those are skipped. */
const isXUrl = (url?: string): boolean => !!url && url.includes("x.com");

/**
 * After PR #76 an X send is *scheduled*, so at send time the ledger row holds the Typefully draft id
 * (as `postId`) and no `x.com` url — the tweet/article isn't live yet. This use-case fetches the draft
 * once it has published and rewrites the row's `postId` → the real X id and `url` → the `x.com` url,
 * so §9b impressions and the dashboard links can find it. Idempotent: already-`x.com` rows are skipped,
 * and a still-scheduled / unavailable draft leaves its row untouched (`pending`).
 */
export class ReconcilePublished {
  constructor(
    private readonly channel: ChannelLedger,
    private readonly article: ArticleLedger,
    private readonly lookup: Lookup,
  ) {}

  async run(): Promise<{ reconciled: number; pending: number }> {
    let reconciled = 0;
    let pending = 0;

    for (const row of await this.channel.loadAll()) {
      if (row.channel !== "x" || isXUrl(row.url) || !row.postId) continue;
      let u: Published;
      try {
        u = await this.lookup.published(row.postId);
      } catch {
        pending += 1;
        continue;
      }
      if (u.xUrl) {
        await this.channel.add({ ...row, postId: u.xId ?? row.postId, url: u.xUrl });
        reconciled += 1;
      } else {
        pending += 1;
      }
    }

    for (const row of await this.article.loadAll()) {
      if (isXUrl(row.url) || !row.postId) continue;
      let u: Published;
      try {
        u = await this.lookup.published(row.postId);
      } catch {
        pending += 1;
        continue;
      }
      if (u.articleUrl) {
        await this.article.add({ ...row, postId: u.articleId ?? row.postId, url: u.articleUrl });
        reconciled += 1;
      } else {
        pending += 1;
      }
    }

    return { reconciled, pending };
  }
}
