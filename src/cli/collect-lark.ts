import "./registerErrorHandler";
import { loadLarkConfig, loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkSourceGateway } from "../adapters/lark/LarkSourceGateway";
import { LarkLocalStore } from "../adapters/lark/LarkLocalStore";
import { CollectLarkMessages } from "../app/CollectLarkMessages";
import { paths } from "../paths";

const config = loadLarkConfig();
const authHttp = new HttpClient(config.baseUrl);
const auth = new LarkAuth(authHttp, config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const source = new LarkSourceGateway(client);

const db = createDb(loadDbConfig());
try {
  // The repository (collected messages) lives in Postgres; the watermark (lark/state.json) stays
  // on disk — collect-lark is a local job, mirroring collect.ts's PgCollectionRepository split.
  const repo = createStores(db).larkRepository;
  const watermark = new LarkLocalStore(paths.larkDir);
  const usecase = new CollectLarkMessages(source, repo, watermark);

  const result = await usecase.run(config.chatIds);
  console.log(`collected ${result.collected} Lark message(s) from ${config.chatIds.length} chat(s)`);
  if (result.failed.length > 0) {
    console.error(`failed to collect from ${result.failed.length} chat(s):`);
    for (const f of result.failed) console.error(`  ${f.chatId}: ${f.error}`);
  }
} finally {
  await db.close();
}
