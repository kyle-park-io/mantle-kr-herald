import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";
import { TypefullyMedia } from "./TypefullyMedia";
import { scheduledPublishAt } from "./typefullyPublish";

const API = "https://api.typefully.com/v2";

export class TypefullySender implements ChannelSender {
  readonly name = "x";
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

  private async uploadPhotos(photos: string[]): Promise<string[]> {
    const media = new TypefullyMedia(this.apiKey, this.socialSetId, this.fetchFn, this.sleep);
    const ids: string[] = [];
    for (const url of photos) ids.push(await media.upload(url));
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
      body: JSON.stringify({ platforms: { x: { enabled: true, posts } }, publish_at: scheduledPublishAt(this.now) }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; share_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
  }
}
