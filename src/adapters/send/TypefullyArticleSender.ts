// src/adapters/send/TypefullyArticleSender.ts
import { scheduledPublishAt } from "./typefullyPublish";
import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";

const API = "https://api.typefully.com/v2";

export class TypefullyArticleSender {
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> {
    const x_article: Record<string, unknown> = { content_markdown: req.content_markdown };
    if (req.cover_media_id) x_article.cover_media_id = req.cover_media_id;
    // Scheduled (not "now"): X blocks direct-publishing drafts with URLs; the scheduled queue allows
    // them. The scheduled draft is not published yet, so report its share_url; the X article id/url
    // is reconciled later (see the live-send spec — this is why postId is the draft id, not §9b's id).
    // The one Typefully call that must never be replayed: a lost response may still have left a
    // scheduled draft behind, and a second one publishes the same post twice.
    const create = await this.http(
      `${API}/social-sets/${this.socialSetId}/drafts`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ platforms: { x_article }, publish_at: scheduledPublishAt(this.now) }) },
      { idempotent: false },
    );
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      // A 5xx is the ambiguous case — a 4xx definitively created nothing, so only the former
      // sends the operator to the queue.
      const ambiguous = create.status >= 500 ? " — the draft may have been created; check the Typefully queue before re-running" : "";
      throw new Error(`Typefully create x_article draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}${ambiguous}`);
    }
    const draft = (await create.json()) as { id?: number | string; share_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
  }
}
