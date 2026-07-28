import { parseArticleId, parseTweetId } from "./typefullyPublish";

const API = "https://api.typefully.com/v2";

/**
 * Fetches a Typefully draft's published X url(s) by draft id — used to reconcile a scheduled post once
 * it has gone live. A still-scheduled draft simply has null urls; a deleted/unknown draft (non-ok
 * response) yields `{}`, which the reconcile treats as "not published yet".
 */
export class TypefullyDraftLookup {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async published(draftId: string): Promise<{ xUrl?: string; xId?: string; articleUrl?: string; articleId?: string }> {
    const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return {};
    const d = (await res.json()) as { x_published_url?: string | null; x_article_published_url?: string | null };
    const xUrl = d.x_published_url ?? undefined;
    const articleUrl = d.x_article_published_url ?? undefined;
    return { xUrl, xId: parseTweetId(xUrl), articleUrl, articleId: parseArticleId(articleUrl) };
  }
}
