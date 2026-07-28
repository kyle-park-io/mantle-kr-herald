import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.telegram.org";

export class TelegramBotSender implements ChannelSender {
  readonly name = "telegram";
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Telegram ${method} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return ((await res.json()) as { result?: unknown }).result;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const photos = (req.photos ?? []).slice(0, 10); // Telegram media-group cap
    let firstId: number | undefined;
    let textSegments = req.segments;

    if (photos.length > 0) {
      // Use the whole text as the media caption only for a single-photo post whose
      // text is a single ≤1024-char segment; then don't re-send it as a message.
      // Media-group posts always carry the text as a separate reply message.
      const asCaption =
        photos.length === 1 && req.segments.length === 1 && (req.segments[0]?.length ?? 0) <= 1024
          ? req.segments[0]
          : undefined;
      if (photos.length === 1) {
        const r = await this.post("sendPhoto", { chat_id: this.chatId, photo: photos[0], ...(asCaption ? { caption: asCaption, parse_mode: "HTML" } : {}) });
        firstId = (r as { message_id?: number })?.message_id;
      } else {
        const media = photos.map((url) => ({ type: "photo", media: url }));
        const r = await this.post("sendMediaGroup", { chat_id: this.chatId, media });
        firstId = (r as { message_id?: number }[])?.[0]?.message_id;
      }
      if (asCaption) textSegments = []; // already delivered as the caption
    }

    for (const text of textSegments) {
      const body: Record<string, unknown> = { chat_id: this.chatId, text, parse_mode: "HTML" };
      if (firstId !== undefined) body.reply_to_message_id = firstId;
      const r = await this.post("sendMessage", body);
      const id = (r as { message_id?: number })?.message_id;
      if (firstId === undefined && typeof id === "number") firstId = id;
    }

    // A channel chat_id is "-100<internal>"; its post link is t.me/c/<internal>/<message_id>.
    const url = firstId !== undefined && this.chatId.startsWith("-100")
      ? `https://t.me/c/${this.chatId.slice(4)}/${firstId}` : undefined;
    return { postId: firstId !== undefined ? String(firstId) : undefined, url };
  }
}
