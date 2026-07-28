const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

/** Uploads a media URL to Typefully and returns its media_id (v2 presigned-S3 flow). */
export class TypefullyMedia {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async upload(url: string): Promise<string> {
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

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const st = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/${media_id}`, { headers: this.headers() });
      if (st.ok) {
        const { status } = (await st.json()) as { status?: string };
        if (status === "ready") return media_id;
        if (status === "failed") throw new Error(`Typefully media processing failed: ${media_id}`);
      }
      await this.sleep(POLL_DELAY_MS);
    }
    throw new Error(`Typefully media not ready after polling: ${media_id}`);
  }
}
