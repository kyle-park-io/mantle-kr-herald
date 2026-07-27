import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

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

  async send(req: SendRequest): Promise<SendResult> {
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        platforms: { x: { enabled: true, posts: req.segments.map((text) => ({ text })) } },
        publish_at: "now",
      }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; x_published_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    if (draft.x_published_url) return { postId: draftId, url: draft.x_published_url };

    // publish_at:"now" can be async — poll the draft for the published url.
    for (let i = 0; i < POLL_ATTEMPTS && draftId; i++) {
      await this.sleep(POLL_DELAY_MS);
      const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, { headers: this.headers() });
      if (!res.ok) continue;
      const d = (await res.json()) as { x_published_url?: string };
      if (d.x_published_url) return { postId: draftId, url: d.x_published_url };
    }
    // Created but the url was not confirmed in the poll window — still a real post; report the id.
    return { postId: draftId, url: undefined };
  }
}
