import "./registerErrorHandler";
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { ReconcileDeletions } from "../app/ReconcileDeletions";

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore("output/x");
const usecase = new ReconcileDeletions(source, store);

const result = await usecase.run();
console.log(`reconciled ${result.checked} tweets; marked ${result.deleted} thread(s) deleted`);
