import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { CollectAuthoredContent } from "../app/CollectAuthoredContent";

const target = process.argv[2] ?? "Mantle_Official";

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore("output");
const usecase = new CollectAuthoredContent(source, store, store);

const result = await usecase.run(target);
console.log(
  `collected ${result.threadCount} threads (${result.fetchedCount} tweets) for @${target}`,
);
