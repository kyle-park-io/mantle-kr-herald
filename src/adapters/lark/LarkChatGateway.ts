import type { LarkChatSummary } from "../../domain/larkChat";
import type { LarkChatGateway as LarkChatGatewayPort } from "../../ports/LarkChatGateway";
import { parseChatsData } from "./schemas";

interface ChatClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

export class LarkChatGateway implements LarkChatGatewayPort {
  constructor(private readonly client: ChatClient) {}

  async listChats(): Promise<LarkChatSummary[]> {
    const chats: LarkChatSummary[] = [];
    let pageToken = "";
    while (true) {
      const params: Record<string, string> = { page_size: "100" };
      if (pageToken) params["page_token"] = pageToken;
      const data = await this.client.get<unknown>("/open-apis/im/v1/chats", params);
      const { items, pageToken: next, hasMore } = parseChatsData(data);
      for (const c of items) chats.push(c);
      if (!hasMore || !next) break;
      pageToken = next;
    }
    return chats;
  }
}
