// src/adapters/send/TypefullyArticleSender.ts
const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

/** The article id in `https://x.com/i/article/<id>`. */
function parseArticleId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /\/article\/(\d+)/.exec(url);
  return m ? m[1] : undefined;
}

export class TypefullyArticleSender {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> {
    const x_article: Record<string, unknown> = { content_markdown: req.content_markdown };
    if (req.cover_media_id) x_article.cover_media_id = req.cover_media_id;
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x_article }, publish_at: "now" }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create x_article draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; x_article_published_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    if (draft.x_article_published_url) return { postId: parseArticleId(draft.x_article_published_url) ?? draftId, url: draft.x_article_published_url };

    for (let i = 0; i < POLL_ATTEMPTS && draftId; i++) {
      await this.sleep(POLL_DELAY_MS);
      const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, { headers: this.headers() });
      if (!res.ok) continue;
      const d = (await res.json()) as { x_article_published_url?: string };
      if (d.x_article_published_url) return { postId: parseArticleId(d.x_article_published_url) ?? draftId, url: d.x_article_published_url };
    }
    return { postId: draftId, url: undefined };
  }
}
