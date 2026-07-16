import type { LarkMessage } from "../../domain/larkMessage";
import type { LarkSourceGateway as LarkSourceGatewayPort } from "../../ports/LarkSourceGateway";
import { normalizeMessage, parseMessagesData } from "./schemas";

interface MessageClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

const COLLECTED_TYPES = new Set(["text", "post"]);

export class LarkSourceGateway implements LarkSourceGatewayPort {
  constructor(private readonly client: MessageClient) {}

  async *fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage> {
    const baseParams: Record<string, string> = {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeAsc",
      page_size: "50",
    };
    if (sinceTime) {
      baseParams["start_time"] = String(Math.floor(Date.parse(sinceTime) / 1000));
    }

    let pageToken = "";
    while (true) {
      const params = pageToken ? { ...baseParams, page_token: pageToken } : baseParams;
      const data = await this.client.get<unknown>("/open-apis/im/v1/messages", params);
      const { items, pageToken: next, hasMore } = parseMessagesData(data);
      for (const raw of items) {
        const msgType = (raw as { msg_type?: unknown }).msg_type;
        if (typeof msgType !== "string" || !COLLECTED_TYPES.has(msgType)) continue;
        const message = normalizeMessage(raw);
        // start_time floors to the second and is inclusive, so the API re-returns messages at
        // the exact watermark instant on every run — exclude anything <= the ms-precise watermark.
        if (sinceTime && message.createdAt <= sinceTime) continue;
        yield message;
      }
      if (!hasMore || !next) break;
      pageToken = next;
    }
  }
}
