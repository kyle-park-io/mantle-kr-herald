import "./registerErrorHandler";
import { loadLarkConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkSourceGateway } from "../adapters/lark/LarkSourceGateway";
import { LarkLocalStore } from "../adapters/lark/LarkLocalStore";
import { CollectLarkMessages } from "../app/CollectLarkMessages";

const config = loadLarkConfig();
const authHttp = new HttpClient(config.baseUrl);
const auth = new LarkAuth(authHttp, config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const source = new LarkSourceGateway(client);
const store = new LarkLocalStore("output/lark");
const usecase = new CollectLarkMessages(source, store, store);

const result = await usecase.run(config.chatIds);
console.log(`collected ${result.collected} Lark message(s) from ${config.chatIds.length} chat(s)`);
if (result.failed.length > 0) {
  console.error(`failed to collect from ${result.failed.length} chat(s):`);
  for (const f of result.failed) console.error(`  ${f.chatId}: ${f.error}`);
}
