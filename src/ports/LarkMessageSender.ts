export interface LarkMessageSender {
  /** Send a plain-text message to a chat; resolves to the created message_id. */
  sendText(chatId: string, text: string): Promise<string>;
}
