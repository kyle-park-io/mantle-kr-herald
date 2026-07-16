import type { LarkChatSummary } from "../domain/larkChat";

export interface LarkChatGateway {
  /** All chats (groups / p2p) the bot is a member of. */
  listChats(): Promise<LarkChatSummary[]>;
}
