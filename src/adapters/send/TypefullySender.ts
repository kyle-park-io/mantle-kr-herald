import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

/**
 * `x_published_url` looks like `https://x.com/i/status/<tweetId>`. Downstream impression
 * tracking (RecordImpressions) looks up posts by X tweet id via twitterapi.io, so the sender must
 * report the tweet id — not Typefully's own draft id — whenever the tweet id is knowable.
 */
function parseTweetId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /\/status\/(\d+)/.exec(url);
  return match ? match[1] : undefined;
}

export class TypefullySender implements ChannelSender {
  readonly name = "x";
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  private async uploadPhotos(photos: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const url of photos) {
      const dl = await this.fetchFn(url);
      if (!dl.ok) throw new Error(`Typefully media download failed: HTTP ${dl.status} for ${url}`);
      const bytes = await dl.arrayBuffer();
      const contentType = dl.headers.get("content-type") ?? "image/jpeg";
      const fileName = url.split("/").pop()?.split("?")[0] || "media.jpg";

      const up = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/upload`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ file_name: fileName }),
      });
      if (!up.ok) throw new Error(`Typefully media/upload failed: HTTP ${up.status}`);
      const { media_id, upload_url } = (await up.json()) as { media_id: string; upload_url: string };

      const put = await this.fetchFn(upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
      if (!put.ok) throw new Error(`Typefully media S3 upload failed: HTTP ${put.status}`);

      let ready = false;
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        const st = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/${media_id}`, { headers: this.headers() });
        if (st.ok) {
          const { status } = (await st.json()) as { status?: string };
          if (status === "ready") { ready = true; break; }
          if (status === "failed") throw new Error(`Typefully media processing failed: ${media_id}`);
        }
        await this.sleep(POLL_DELAY_MS);
      }
      if (!ready) throw new Error(`Typefully media not ready after polling: ${media_id}`);
      ids.push(media_id);
    }
    return ids;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const mediaIds = req.photos?.length ? await this.uploadPhotos(req.photos) : [];
    const posts = req.segments.map((text, i) =>
      i === 0 && mediaIds.length ? { text, media_ids: mediaIds } : { text },
    );
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        platforms: { x: { enabled: true, posts } },
        publish_at: "now",
      }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; x_published_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    if (draft.x_published_url) return { postId: parseTweetId(draft.x_published_url) ?? draftId, url: draft.x_published_url };

    // publish_at:"now" can be async — poll the draft for the published url.
    for (let i = 0; i < POLL_ATTEMPTS && draftId; i++) {
      await this.sleep(POLL_DELAY_MS);
      const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, { headers: this.headers() });
      if (!res.ok) continue;
      const d = (await res.json()) as { x_published_url?: string };
      if (d.x_published_url) return { postId: parseTweetId(d.x_published_url) ?? draftId, url: d.x_published_url };
    }
    // Created but the url was not confirmed in the poll window — still a real post; report the id.
    return { postId: draftId, url: undefined };
  }
}
