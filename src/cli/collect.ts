import "./registerErrorHandler";
import { loadConfig, loadDbConfig } from "../config";
import { argValue } from "./args";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { JsonCollectionRunLedger } from "../adapters/store/JsonCollectionRunLedger";
import { CollectAuthoredContent, type CollectOptions } from "../app/CollectAuthoredContent";
import { parseSince } from "../shared/time/parseSince";
import { parseCollectMaxPages } from "./collectMaxPages";
import { paths } from "../paths";
import { SWEPT_ACCOUNT } from "../domain/sweptAccount";

// `SWEPT_ACCOUNT` rather than the literal: the translate floor now asks "is this the account the
// sweep reads?" (`meetsTranslateFloor`, for the translate tick, the 링크 수집 waiting list and the
// Collected count alike), and that question has to be about the same account this default names.
// Which account is swept is unchanged — only where the name lives.
const target = process.argv[2]?.startsWith("--") ? SWEPT_ACCOUNT : process.argv[2] ?? SWEPT_ACCOUNT;

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
// This is the one command HERALD_COLLECT_MAX_PAGES is documented for: raising the page cap for a
// single hand-run backfill after a coverage GAP alert (docs/ko/team-runbook.md §4). Read here
// rather than inside the gateway so the override reaches this entry point and not the four others
// that build the same gateway for unrelated work; an invalid value throws before any API call.
const source = new TwitterApiSourceGateway(client, {
  maxPages: parseCollectMaxPages(process.env.HERALD_COLLECT_MAX_PAGES),
});
const ledger = new JsonCollectionRunLedger(paths.xRuns);

const db = createDb(loadDbConfig());
try {
  // The repository (collected threads) lives in Postgres; the watermark (x/state.json) stays on
  // disk — collect is a local job, per the plan's carried-forward design.
  const repo = createStores(db).collectionRepository;
  const watermark = new LocalJsonStore(paths.xDir);
  const usecase = new CollectAuthoredContent(source, repo, watermark, ledger);

  const { run } = await usecase.run(target, opts);

  const cov = run.covered ? `covered ${run.covered.from} ~ ${run.covered.to}` : "nothing new in window";
  const gap = run.gap ? `, GAP ${run.gap.from ?? "(open)"} ~ ${run.gap.to} (limit reached)` : "";
  console.log(
    `collected ${run.threadCount} threads (${run.tweetCount} tweets) for @${target} — ${cov}${gap}`,
  );
} finally {
  await db.close();
}
