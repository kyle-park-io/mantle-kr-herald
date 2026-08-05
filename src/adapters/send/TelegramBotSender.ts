import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.telegram.org";

export class TelegramBotSender implements ChannelSender {
  readonly name = "telegram";
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post(method: string, body: Record<string, unknown>, init?: RequestInit): Promise<any> {
    const res = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Telegram ${method} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return ((await res.json()) as { result?: unknown }).result;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const chatId = req.chatId;
    // Refused here rather than at construction: a room's id is a property of the send, and a
    // missing one must not stop the other rooms' sends from being built and delivered. There is no
    // sender-level default to fall back on — one would post this room's copy to whichever room the
    // default named.
    if (!chatId) throw new Error("No Telegram chat id for this send: set the room's TELEGRAM_CHAT_ID_* variable");
    const photos = (req.photos ?? []).slice(0, 10); // Telegram media-group cap
    let firstId: number | undefined;
    // The message the pin (below) targets. Usually equal to firstId, except: (1) a media-group
    // send, where firstId is the album but the pinned bar should show the text, not "Photo"; and
    // (2) a single-photo send whose text did not fit as the caption (too long, or split into 2+
    // segments), where firstId is the photo but the text went out as a separate sendMessage.
    let textId: number | undefined;
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
        const r = await this.post("sendPhoto", { chat_id: chatId, photo: photos[0], ...(asCaption ? { caption: asCaption, parse_mode: "HTML" } : {}) });
        firstId = (r as { message_id?: number })?.message_id;
        if (asCaption) textId = firstId; // the caption is the text, so the photo carries it
      } else {
        const media = photos.map((url) => ({ type: "photo", media: url }));
        const r = await this.post("sendMediaGroup", { chat_id: chatId, media });
        firstId = (r as { message_id?: number }[])?.[0]?.message_id;
      }
      if (asCaption) textSegments = []; // already delivered as the caption
    }

    for (const text of textSegments) {
      const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
      if (firstId !== undefined) body.reply_to_message_id = firstId;
      const r = await this.post("sendMessage", body);
      const id = (r as { message_id?: number })?.message_id;
      if (firstId === undefined && typeof id === "number") firstId = id;
      if (textId === undefined && typeof id === "number") textId = id;
    }

    // A channel chat_id is "-100<internal>"; its post link is t.me/c/<internal>/<message_id>.
    const url = firstId !== undefined && chatId.startsWith("-100")
      ? `https://t.me/c/${chatId.slice(4)}/${firstId}` : undefined;
    const result: SendResult = { postId: firstId !== undefined ? String(firstId) : undefined, url };

    const pinTargetId = textId ?? firstId; // no text-bearing message at all: fall back to firstId
    if (req.pin) {
      if (pinTargetId === undefined) {
        // Every call above answered with no message_id at all, so there is nothing to give
        // pinChatMessage. Skipping this silently would look exactly like the checkbox never having
        // been ticked, so it gets the same warning treatment as a pin call that actually fails below.
        result.warning = "글은 올라갔지만 고정할 메시지 ID를 받지 못해 고정하지 못했습니다 — 텔레그램에서 직접 고정해 주세요";
      } else {
        // The post above is already live in the room. SendChannels' catch around sender.send()
        // treats any throw as a failed send and skips the ledger write, which would make the next
        // run re-post this same item — so a pin failure must surface as a warning, never a throw.
        try {
          // The pin is the one call in send() that is entirely optional: the post is already live,
          // so a hung request here (undici's default header timeout is ~300s) must not hold send()
          // open — with it, a live post and no ledger row — for minutes. 5s is generous for one
          // small Bot API call and short enough that abandoning it on timeout is the right call; the
          // catch below turns that abort into the same warning as any other pin failure.
          await this.post(
            "pinChatMessage",
            { chat_id: chatId, message_id: pinTargetId, disable_notification: true },
            { signal: AbortSignal.timeout(5000) },
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // The remedy — what an operator can actually act on — comes first; the raw API detail
          // (which still matters, e.g. to tell "chat not found" from "not enough rights") trails it
          // rather than sitting in the middle of the Korean sentence.
          result.warning = `글은 올라갔지만 고정하지 못했습니다 — 봇을 이 방의 관리자로 올리고, 그룹은 '메시지 고정', 채널은 '메시지 수정' 권한을 주세요 (${detail})`;
        }
      }
    }
    return result;
  }
}
