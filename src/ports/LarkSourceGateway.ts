import type { LarkMessage } from "../domain/larkMessage";

export interface LarkSourceGateway {
  /** Messages in a chat newer than sinceTime (ISO), streamed via pagination. */
  fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage>;
}
