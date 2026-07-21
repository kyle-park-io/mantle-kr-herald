import "./registerErrorHandler";
import { loadConfig } from "../config";
import { argValue } from "./args";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { JsonCollectionRunLedger } from "../adapters/store/JsonCollectionRunLedger";
import { CollectAuthoredContent, type CollectOptions } from "../app/CollectAuthoredContent";
import { parseSince } from "../shared/time/parseSince";
import { paths } from "../paths";

const target = process.argv[2]?.startsWith("--") ? "Mantle_Official" : process.argv[2] ?? "Mantle_Official";

const opts: CollectOptions = {};
const since = argValue("--since");
if (since) opts.since = parseSince(since, new Date());
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid --limit "${limit}" (use a positive integer)`);
  opts.limit = Math.floor(n);
}

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore(paths.xDir);
const ledger = new JsonCollectionRunLedger(paths.xRuns);
const usecase = new CollectAuthoredContent(source, store, store, ledger);

const { run } = await usecase.run(target, opts);

const cov = run.covered ? `covered ${run.covered.from} ~ ${run.covered.to}` : "nothing new in window";
const gap = run.gap ? `, GAP ${run.gap.from ?? "(open)"} ~ ${run.gap.to} (limit reached)` : "";
console.log(
  `collected ${run.threadCount} threads (${run.tweetCount} tweets) for @${target} — ${cov}${gap}`,
);
