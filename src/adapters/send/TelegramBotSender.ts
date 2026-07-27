import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.telegram.org";

export class TelegramBotSender implements ChannelSender {
  readonly name = "telegram";
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(req: SendRequest): Promise<SendResult> {
    let firstId: number | undefined;
    for (const text of req.segments) {
      const body: Record<string, unknown> = { chat_id: this.chatId, text, parse_mode: "HTML" };
      if (firstId !== undefined) body.reply_to_message_id = firstId;
      const res = await this.fetchFn(`${API}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Telegram sendMessage failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
      }
      const data = (await res.json()) as { result?: { message_id?: number } };
      const id = data.result?.message_id;
      if (firstId === undefined && typeof id === "number") firstId = id;
    }
    // A channel chat_id is "-100<internal>"; its post link is t.me/c/<internal>/<message_id>.
    const url =
      firstId !== undefined && this.chatId.startsWith("-100")
        ? `https://t.me/c/${this.chatId.slice(4)}/${firstId}`
        : undefined;
    return { postId: firstId !== undefined ? String(firstId) : undefined, url };
  }
}
