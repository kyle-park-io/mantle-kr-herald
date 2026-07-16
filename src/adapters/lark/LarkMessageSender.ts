import type { LarkMessageSender as LarkMessageSenderPort } from "../../ports/LarkMessageSender";
import { parseSendResult } from "./schemas";

interface SendClient {
  post<T>(path: string, body?: unknown): Promise<T>;
}

export class LarkMessageSender implements LarkMessageSenderPort {
  constructor(private readonly client: SendClient) {}

  async sendText(chatId: string, text: string): Promise<string> {
    const body = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    };
    const res = await this.client.post<unknown>(
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      body,
    );
    return parseSendResult(res);
  }
}
