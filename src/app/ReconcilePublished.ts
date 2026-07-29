import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { DraftLookup } from "../ports/DraftLookup";
import type { DraftState } from "../domain/send/draftState";
import { awaitingPublish, awaitingArticlePublish } from "../domain/send/awaitingPublish";

interface ArticleRow {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
  /** Set when the row is retired — see the `gone` branch below and `XArticleSentEntry`. */
  droppedAt?: string;
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
 *
 * `lookup.published()` answers three ways (see `DraftState`), not two: a `gone` draft was deleted
 * before it published and will never publish, so this pass retires the row instead of polling it
 * forever — `status: "dropped"` for a delivery row, `droppedAt` for an article row (which has no
 * `status` field to widen). Both are picked up by `awaitingPublish`/`awaitingArticlePublish` and
 * `deliveredToRoom`, so a retired row stops holding its quota slot and its room becomes sendable
 * again. `postId` and `at`/`sentAt` are preserved verbatim on a retired row — they are the only
 * record of which Typefully draft this was, and a later manual check (the live-send protocol) needs
 * the draft id to correlate against Typefully's own history.
 *
 * Getting `gone` wrong in the other direction — retiring a row whose draft was in fact about to
 * publish — is the dangerous case: the ledger stops tracking it, a later run can no longer see it,
 * and re-sending the same content publishes it a second time to a brand's own account. That is why
 * `TypefullyDraftLookup` only ever answers `gone` on an unambiguous 404, and everything else
 * (including a thrown request, handled by the `try/catch` below) stays `pending`.
 */
export class ReconcilePublished {
  constructor(
    private readonly delivery: Pick<DeliveryLedger, "loadAll" | "add">,
    private readonly article: ArticleLedger,
    private readonly lookup: Pick<DraftLookup, "published">,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(): Promise<{ reconciled: number; retired: number; pending: number }> {
    let reconciled = 0;
    let retired = 0;
    let pending = 0;

    for (const row of await this.delivery.loadAll()) {
      // The same predicate the board paints `예약됨` from, so the screen and this pass cannot
      // disagree about which rows are still waiting on Typefully's queue. A `dropped` row already
      // fails this check, so a retired row is never looked up again.
      if (!awaitingPublish(row)) continue;
      let u: DraftState;
      try {
        u = await this.lookup.published(row.postId);
      } catch {
        pending += 1;
        continue;
      }
      if (u.state === "published" && u.xUrl) {
        await this.delivery.add({ ...row, postId: u.xId ?? row.postId, url: u.xUrl });
        reconciled += 1;
      } else if (u.state === "gone") {
        await this.delivery.add({ ...row, status: "dropped" });
        retired += 1;
      } else {
        pending += 1;
      }
    }

    for (const row of await this.article.loadAll()) {
      if (!awaitingArticlePublish(row)) continue;
      let u: DraftState;
      try {
        u = await this.lookup.published(row.postId);
      } catch {
        pending += 1;
        continue;
      }
      if (u.state === "published" && u.articleUrl) {
        await this.article.add({ ...row, postId: u.articleId ?? row.postId, url: u.articleUrl });
        reconciled += 1;
      } else if (u.state === "gone") {
        await this.article.add({ ...row, droppedAt: this.now() });
        retired += 1;
      } else {
        pending += 1;
      }
    }

    return { reconciled, retired, pending };
  }
}
