import "./registerErrorHandler";
import { argValue, parseList } from "./args";
import { loadLarkAppConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkMessageSender } from "../adapters/lark/LarkMessageSender";
import { SendLarkMessage } from "../app/SendLarkMessage";

const config = loadLarkAppConfig();
const text = argValue("--text");
if (!text) throw new Error("Missing --text. Usage: pnpm lark:send --chat <id> --text <message>");
const chatId = argValue("--chat") ?? parseList(process.env.LARK_CHAT_IDS)?.[0];
if (!chatId) throw new Error("No chat id. Pass --chat <id> or set LARK_CHAT_IDS in .env");

const auth = new LarkAuth(new HttpClient(config.baseUrl), config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const usecase = new SendLarkMessage(new LarkMessageSender(client));

const { messageId } = await usecase.run(chatId, text);
console.log(`sent message ${messageId} to ${chatId}`);
