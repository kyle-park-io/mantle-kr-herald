import type { LarkMessageSender } from "../ports/LarkMessageSender";

export interface SendLarkResult {
  messageId: string;
}

export class SendLarkMessage {
  constructor(private readonly sender: LarkMessageSender) {}

  async run(chatId: string, text: string): Promise<SendLarkResult> {
    const messageId = await this.sender.sendText(chatId, text);
    return { messageId };
  }
}
