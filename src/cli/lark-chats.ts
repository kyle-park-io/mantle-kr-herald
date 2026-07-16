import "./registerErrorHandler";
import { loadLarkConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkChatGateway } from "../adapters/lark/LarkChatGateway";

const config = loadLarkConfig();
const auth = new LarkAuth(new HttpClient(config.baseUrl), config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const gateway = new LarkChatGateway(client);

const chats = await gateway.listChats();
if (chats.length === 0) {
  console.log("The bot is not in any chats yet. Add it to a group in Lark, then re-run.");
} else {
  console.log(`bot is in ${chats.length} chat(s):`);
  for (const c of chats) console.log(`  ${c.chatId}  ${c.name}`);
}
