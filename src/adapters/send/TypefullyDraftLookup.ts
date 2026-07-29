import { parseArticleId, parseTweetId } from "./typefullyPublish";
import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";
import type { DraftState } from "../../domain/send/draftState";
import type { DraftLookup } from "../../ports/DraftLookup";

const API = "https://api.typefully.com/v2";

/**
 * Typefully's side of a scheduled draft: what became of it (`published`), and — for the resend guard
 * in `sendToOutlet.ts` — the ability to pull it out of the queue before it goes live (`cancel`).
 *
 * `published()` answers three ways, not two:
 * - `published`  — `x_published_url` or `x_article_published_url` is present and non-null.
 * - `scheduled`  — the draft still exists but neither url is set yet, *or* the request came back
 *   non-ok for any reason other than 404 (rate limiting, a 5xx blip, an expired key). Treating those
 *   as "still scheduled" rather than "gone" matters: this method has no way to tell "Typefully is
 *   briefly unavailable" from "the draft was deleted", so it must assume the safer of the two — a
 *   row that stays stuck a little longer is recoverable, a row retired by mistake is not.
 * - `gone`       — a 404. Typefully returns this only when the draft id itself is unknown, which
 *   means it was deleted (cancelled, or removed by hand in the Typefully UI) and will never publish.
 *   This is the one non-ok status allowed to end the wait, because getting it wrong the other way —
 *   calling a live draft `gone` — retires a row that later goes out for real, so the ledger never
 *   learns its x.com url and the same content can be scheduled again.
 *
 * A thrown request (network failure, exhausted retries) is not caught here — it propagates so a
 * caller cannot mistake "the request never completed" for a definite state. That holds for `cancel`
 * too: see its own comment.
 */
export class TypefullyDraftLookup implements DraftLookup {
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }

  async published(draftId: string): Promise<DraftState> {
    const res = await this.http(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return { state: res.status === 404 ? "gone" : "scheduled" };
    const d = (await res.json()) as { x_published_url?: string | null; x_article_published_url?: string | null };
    const xUrl = d.x_published_url ?? undefined;
    const articleUrl = d.x_article_published_url ?? undefined;
    if (!xUrl && !articleUrl) return { state: "scheduled" };
    return { state: "published", xUrl, xId: parseTweetId(xUrl), articleUrl, articleId: parseArticleId(articleUrl) };
  }

  /**
   * Deletes a queued draft, answering whether it is gone afterwards.
   *
   * `true` on any 2xx (Typefully answers 204) and on a 404 — a draft Typefully no longer knows about
   * is exactly the end state a cancel is asking for, and the caller only cares about the end state.
   * `false` on anything else, which the resend guard reads as "the original may still publish" and
   * refuses on: answering `true` here for a draft still in the queue is a second live post.
   *
   * Goes through the shared retry wrapper with its default idempotent handling, unlike draft
   * creation: deleting the same draft twice leaves the same nothing behind, so a replay costs
   * nothing, while a lost 204 that is never retried would refuse a resend the operator is entitled to.
   *
   * A thrown request propagates, exactly as in `published()` above — "the request never completed" is
   * not "the draft is still there", and squashing it into `false` here would hide the difference from
   * a caller that may want to say so.
   */
  async cancel(draftId: string): Promise<boolean> {
    const res = await this.http(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    return res.ok || res.status === 404;
  }
}
