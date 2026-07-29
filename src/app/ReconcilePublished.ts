import type { DeliveryLedger } from "../ports/DeliveryLedger";
import { awaitingPublish, awaitingArticlePublish, isXUrl } from "../domain/send/awaitingPublish";

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

/**
 * After PR #76 an X send is *scheduled*, so at send time the ledger row holds the Typefully draft id
 * (as `postId`) and no `x.com` url — the tweet/article isn't live yet. This use-case fetches the draft
 * once it has published and rewrites the row's `postId` → the real X id and `url` → the `x.com` url,
 * so §9b impressions and the dashboard links can find it. Idempotent: already-`x.com` rows are skipped,
 * and a still-scheduled / unavailable draft leaves its row untouched (`pending`).
 *
 * Reads the same outlet-keyed ledger `send:channels` writes. It used to read the pre-outlet
 * `channels.json`, which stopped being written the moment sends became per-room — every fix would
 * have landed in a file nothing else reads, leaving the board showing Typefully draft ids for every
 * X post.
 */
export class ReconcilePublished {
  constructor(
    private readonly delivery: Pick<DeliveryLedger, "loadAll" | "add">,
    private readonly article: ArticleLedger,
    private readonly lookup: Lookup,
  ) {}

  async run(): Promise<{ reconciled: number; pending: number }> {
    let reconciled = 0;
    let pending = 0;

    for (const row of await this.delivery.loadAll()) {
      // The same predicate the board paints `예약됨` from, so the screen and this pass cannot
      // disagree about which rows are still waiting on Typefully's queue.
      if (!awaitingPublish(row)) continue;
      let u: Published;
      try {
        u = await this.lookup.published(row.postId);
      } catch {
        pending += 1;
        continue;
      }
      if (u.xUrl) {
        await this.delivery.add({ ...row, postId: u.xId ?? row.postId, url: u.xUrl });
        reconciled += 1;
      } else {
        pending += 1;
      }
    }

    for (const row of await this.article.loadAll()) {
      if (!awaitingArticlePublish(row)) continue;
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
