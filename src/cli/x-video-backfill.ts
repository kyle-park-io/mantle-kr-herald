import "./registerErrorHandler";
import { loadConfig, loadDbConfig, tryDescribeDbTarget, INVALID_DB_URL } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { BackfillVideoUrls } from "../app/BackfillVideoUrls";
import { videoBackfillPlanLines } from "./videoBackfillReport";

/**
 * `pnpm x:video-backfill [--yes]` — fill `videoUrl` on stored video media that has none, by tweet id.
 *
 * The gap this fills, and why a re-collect is not the answer, is in `BackfillVideoUrls`'s own doc
 * comment: the last stragglers are posts the account listing no longer returns at all, so only a
 * fetch by id reaches them. Same shape as `x:link`, for the same reason.
 *
 * Reads and writes exactly one table — `x_threads`, through `CollectionRepository` — and nothing
 * else: no translations, no renderings, no sheet, no collect watermark. Previews by default and
 * writes only under `--yes`, the convention `x:reconcile`/`x:link` already use.
 */
const writeConfirmed = process.argv.includes("--yes");

const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const dbConfig = loadDbConfig();
const db = createDb(dbConfig);
try {
  // Names the database on the first line, like every other CLI here — this one rewrites collected
  // source content, so "which database am I about to edit" is the first thing to be sure of.
  console.log(
    `x:video-backfill — database ${dbConfig.env} · ${tryDescribeDbTarget(dbConfig) ?? INVALID_DB_URL}` +
      `${writeConfirmed ? "" : " (preview — no --yes)"}`,
  );

  const usecase = new BackfillVideoUrls(gateway, createStores(db).collectionRepository);
  const plan = await usecase.plan();

  console.log(`\n${videoBackfillPlanLines(plan).join("\n")}`);

  if (plan.patched.length === 0) {
    // Covers both "nothing was missing" and "nothing could be filled": either way `--yes` would
    // write nothing, so it must not be advertised as if it would.
    console.log(`\nnothing to write.`);
  } else if (!writeConfirmed) {
    console.log(
      `\npreview only — nothing was written. Re-run with --yes to fill ${plan.filled} media ` +
        `in ${plan.patched.length} thread(s).`,
    );
  } else {
    console.log(`\nwriting…`);
    const written = await usecase.apply(plan);
    console.log(`  ✓ filled ${plan.filled} media in ${written} thread(s)`);
  }
} finally {
  await db.close();
}
