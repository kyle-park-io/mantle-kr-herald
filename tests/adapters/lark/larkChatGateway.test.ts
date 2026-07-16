import { describe, it, expect } from "vitest";
import { LarkChatGateway } from "../../../src/adapters/lark/LarkChatGateway";

class FakeClient {
  public calls: Record<string, string>[] = [];
  constructor(private readonly responder: (params?: Record<string, string>) => unknown) {}
  async get<T>(_path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push(params ?? {});
    return this.responder(params) as T;
  }
}

describe("LarkChatGateway", () => {
  it("paginates via page_token and returns all chat summaries", async () => {
    const client = new FakeClient((params) =>
      params?.page_token
        ? { code: 0, data: { items: [{ chat_id: "oc_2", name: "B" }], has_more: false } }
        : { code: 0, data: { items: [{ chat_id: "oc_1", name: "A" }], has_more: true, page_token: "pt1" } },
    );
    const gw = new LarkChatGateway(client);

    const chats = await gw.listChats();

    expect(chats).toEqual([
      { chatId: "oc_1", name: "A" },
      { chatId: "oc_2", name: "B" },
    ]);
    expect(client.calls[0].page_size).toBe("100");
    expect(client.calls[1].page_token).toBe("pt1");
  });
});
