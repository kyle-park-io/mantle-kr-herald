// src/adapters/send/TypefullyArticleSender.ts
import { scheduledPublishAt } from "./typefullyPublish";

const API = "https://api.typefully.com/v2";

export class TypefullyArticleSender {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> {
    const x_article: Record<string, unknown> = { content_markdown: req.content_markdown };
    if (req.cover_media_id) x_article.cover_media_id = req.cover_media_id;
    // Scheduled (not "now"): X blocks direct-publishing drafts with URLs; the scheduled queue allows
    // them. The scheduled draft is not published yet, so report its share_url; the X article id/url
    // is reconciled later (see the live-send spec — this is why postId is the draft id, not §9b's id).
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x_article }, publish_at: scheduledPublishAt(this.now) }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create x_article draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; share_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
  }
}
