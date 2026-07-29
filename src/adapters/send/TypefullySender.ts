import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";
import { TypefullyMedia } from "./TypefullyMedia";
import { scheduledPublishAt } from "./typefullyPublish";
import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";

const API = "https://api.typefully.com/v2";

export class TypefullySender implements ChannelSender {
  readonly name = "x";
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
    // The one Typefully call that must never be replayed: a lost response may still have left a
    // scheduled draft behind, and a second one publishes the same post twice.
    const create = await this.http(
      `${API}/social-sets/${this.socialSetId}/drafts`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ platforms: { x: { enabled: true, posts } }, publish_at: scheduledPublishAt(this.now) }) },
      { idempotent: false },
    );
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      // A 5xx is the ambiguous case — a 4xx definitively created nothing, so only the former
      // sends the operator to the queue.
      const ambiguous = create.status >= 500 ? " — the draft may have been created; check the Typefully queue before re-running" : "";
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}${ambiguous}`);
    }
    // A 200 already came back: the draft's existence is certain, not ambiguous — the per-attempt
    // timeout signal (`createTypefullyFetch`) stays armed after `fetch()` resolves, so a body that
    // stalls past the budget throws here, outside the retry wrapper's idempotency handling. Say what
    // is actually true instead of the wrapper's hedged "may still have been processed".
    let draft: { id?: number | string; share_url?: string };
    try {
      draft = (await create.json()) as { id?: number | string; share_url?: string };
    } catch (err) {
      throw new Error(
        `Typefully accepted the draft but its response could not be read: ${(err as Error).message} — the draft WAS created; check the Typefully queue before re-running`,
        { cause: err },
      );
    }
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    return { postId: draftId, url: draft.share_url };
  }
}
