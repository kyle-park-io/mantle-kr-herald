import { join } from "node:path";
import type { Db } from "../adapters/db/Db";
import { PgDeliveryLedger } from "../adapters/store/PgDeliveryLedger";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { PgXArticleLedger } from "../adapters/store/PgXArticleLedger";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";

/**
 * The safety net for the Postgres cutover. `JsonDeliveryLedger` protected the send history
 * automatically, on every read: if `deliveries.json` was missing it fell back to the legacy
 * `channels.json`, so an install could never accidentally present itself as having sent nothing.
 * The database has no such fallback — `PgDeliveryLedger.loadAll()` on an empty table returns the
 * empty set, and that looks exactly like a genuinely fresh install.
 *
 * If the cutover happens without `pnpm db:import` having run, `SendChannels.run()`'s `already` and
 * `planRooms()`'s `everDelivered` both read "never sent" for the entire backlog, and the next send
 * re-posts all of it to live Telegram rooms and the brand's X account. Every guard in the send path
 * is downstream of that read, so none of them catch it — this function is the one place that does.
 *
 * The rule: an **empty** deliveries table plus a populated `output/publish/deliveries.json` or
 * `channels.json` still on disk means `db:import` was never run — refuse and say so. An empty table
 * with no legacy file present is a legitimately fresh install and proceeds silently.
 *
 * Reads the legacy tree through `JsonDeliveryLedger` — never parses `deliveries.json`/
 * `channels.json` by hand — so the exclusive-or it already implements (`channels.json` only when
 * `deliveries.json` is entirely absent) is inherited rather than re-derived: a present-but-empty
 * `deliveries.json` correctly reads as "nothing was ever sent" here too, the same as it always has.
 *
 * The identical hazard exists one ledger over: `x_article_deliveries` (Typefully-scheduled X
 * Articles, `send-x-article.ts`) has the same "empty table looks like a fresh install" property,
 * against `output/publish/x-article.json` instead — checked the same way, minus the legacy-file
 * fallback (`JsonXArticleLedger` never had a pre-outlet predecessor to fall back to). Left unchecked,
 * an unmigrated `x_article_deliveries` table would re-post every X Article to the brand's account
 * exactly as an unmigrated `deliveries` table would for Telegram — the plan's own framing of the
 * risk ("re-posts the entire backlog to live Telegram rooms and the brand's X account") already
 * names both destinations, so both ledgers are checked here.
 *
 * `outputRoot` is a parameter (not `OUTPUT_DIR` baked in) so this is testable against an arbitrary
 * tmpdir, the same shape `db-import.ts`/`db-export.ts` use.
 */
export async function assertLedgerMigrated(db: Db, outputRoot: string): Promise<void> {
  const publishDir = join(outputRoot, "publish");

  const deliveries = await new PgDeliveryLedger(db).loadAll();
  if (deliveries.length === 0) {
    const legacy = await new JsonDeliveryLedger(publishDir).loadAll();
    if (legacy.length > 0) {
      throw new Error(
        `The deliveries table is empty, but ${publishDir} still holds ${legacy.length} sent row(s) on ` +
          `disk (deliveries.json or the legacy channels.json). This looks like \`pnpm db:import\` was never ` +
          `run against this database. Refusing to send: every guard on the send path reads "never sent" ` +
          `from an empty table, and the next send would re-post the entire history to live Telegram rooms ` +
          `and the brand's X account. Run \`pnpm db:import\` first, or confirm this is really a fresh ` +
          `install and remove the stale file(s) from disk.`,
      );
    }
  }

  const xArticles = await new PgXArticleLedger(db).loadAll();
  if (xArticles.length === 0) {
    const legacy = await new JsonXArticleLedger(publishDir).loadAll();
    if (legacy.length > 0) {
      throw new Error(
        `The x_article_deliveries table is empty, but ${publishDir}/x-article.json still holds ` +
          `${legacy.length} sent row(s) on disk. This looks like \`pnpm db:import\` was never run against ` +
          `this database. Refusing to send: the next send would re-post every X Article to the brand's X ` +
          `account. Run \`pnpm db:import\` first, or confirm this is really a fresh install and remove the ` +
          `stale file from disk.`,
      );
    }
  }
}
