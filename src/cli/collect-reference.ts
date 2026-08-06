import "./registerErrorHandler";
import { loadConfig } from "../config";
import { argValue } from "./args";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { JsonCollectionRunLedger } from "../adapters/store/JsonCollectionRunLedger";
import { CollectAuthoredContent, type CollectOptions } from "../app/CollectAuthoredContent";
import { parseSince } from "../shared/time/parseSince";
import { parseCollectMaxPages } from "./collectMaxPages";
import { paths } from "../paths";

const handle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";
const target = process.argv[2]?.startsWith("--") ? handle : process.argv[2] ?? handle;

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
// Honours HERALD_COLLECT_MAX_PAGES for the same reason `collect.ts` does: this command also runs
// `CollectAuthoredContent`, so exhausting the page cap here also advances a watermark past an
// un-fetched older tail. It is the one command `pnpm tm:measure` exists to size — that report
// estimates the reference account's volume *against the cap*, which would be an estimate with no
// dial to act on if the cap were unreachable from here.
const source = new TwitterApiSourceGateway(client, {
  maxPages: parseCollectMaxPages(process.env.HERALD_COLLECT_MAX_PAGES),
});
const store = new LocalJsonStore(paths.referenceDir);
const ledger = new JsonCollectionRunLedger(paths.referenceRuns);
const usecase = new CollectAuthoredContent(source, store, store, ledger);

const { run } = await usecase.run(target, opts);

const cov = run.covered ? `covered ${run.covered.from} ~ ${run.covered.to}` : "nothing new in window";
const gap = run.gap ? `, GAP ${run.gap.from ?? "(open)"} ~ ${run.gap.to} (limit reached)` : "";
console.log(
  `collected ${run.threadCount} reference threads (${run.tweetCount} tweets) for @${target} — ${cov}${gap}`,
);
