import { describe, it, expect } from "vitest";
import { SendLarkMessage } from "../../src/app/SendLarkMessage";
import type { LarkMessageSender } from "../../src/ports/LarkMessageSender";

class FakeSender implements LarkMessageSender {
  public calls: { chatId: string; text: string }[] = [];
  async sendText(chatId: string, text: string): Promise<string> {
    this.calls.push({ chatId, text });
    return "om_sent";
  }
}

describe("SendLarkMessage", () => {
  it("delegates to the sender and returns the message id", async () => {
    const sender = new FakeSender();
    const result = await new SendLarkMessage(sender).run("oc_x", "hello");
    expect(result).toEqual({ messageId: "om_sent" });
    expect(sender.calls).toEqual([{ chatId: "oc_x", text: "hello" }]);
  });
});
