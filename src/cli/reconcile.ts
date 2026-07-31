import "./registerErrorHandler";
import { loadConfig, loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { ReconcileDeletions } from "../app/ReconcileDeletions";

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);

const db = createDb(loadDbConfig());
try {
  const usecase = new ReconcileDeletions(source, createStores(db).collectionRepository);
  const result = await usecase.run();
  console.log(`reconciled ${result.checked} tweets; marked ${result.deleted} thread(s) deleted`);
} finally {
  await db.close();
}
