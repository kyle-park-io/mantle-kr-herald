import { describe, it, expect } from "vitest";
import { LarkMessageSender } from "../../../src/adapters/lark/LarkMessageSender";

class FakeClient {
  public calls: { path: string; body?: unknown }[] = [];
  constructor(private readonly responder: () => unknown) {}
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    return this.responder() as T;
  }
}

describe("LarkMessageSender", () => {
  it("posts a text message and returns the message_id", async () => {
    const client = new FakeClient(() => ({ code: 0, data: { message_id: "om_1" } }));
    const sender = new LarkMessageSender(client);

    const id = await sender.sendText("oc_x", "hello");

    expect(id).toBe("om_1");
    expect(client.calls[0].path).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(client.calls[0].body).toEqual({
      receive_id: "oc_x",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
  });

  it("throws on a non-zero code", async () => {
    const client = new FakeClient(() => ({ code: 230002, msg: "no permission" }));
    const sender = new LarkMessageSender(client);
    await expect(sender.sendText("oc_x", "hi")).rejects.toThrow(/230002/);
  });
});
