import "./registerErrorHandler";
import { argValue } from "./args";
import { loadTypefullyConfig, loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { assertLedgerMigrated } from "./assertLedgerMigrated";
import { OUTPUT_DIR } from "../paths";
import { TypefullyMedia } from "../adapters/send/TypefullyMedia";
import { TypefullyArticleSender } from "../adapters/send/TypefullyArticleSender";
import { SendXArticle } from "../app/SendXArticle";
import { headroomReader } from "./publishHeadroom";

const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const c = loadTypefullyConfig();

const db = createDb(loadDbConfig());
try {
  // Refuses to send when the x-article ledger looks unmigrated — see assertLedgerMigrated's own
  // doc comment.
  await assertLedgerMigrated(db, OUTPUT_DIR);
  const stores = createStores(db);
  const articleLedger = stores.xArticleLedger;
  // Headroom spans both ledgers (x-post rooms and x-article), so this one-shot process reads its
  // own delivery ledger just for that. Unlike serve.ts, nothing else here shares this instance, so
  // there is no second serializer chain to race.
  const deliveryLedger = stores.deliveryLedger;
  const result = await new SendXArticle(
    stores.translationStore,
    stores.xArticleMeta,
    new TypefullyMedia(c.apiKey, c.socialSetId),
    new TypefullyArticleSender(c.apiKey, c.socialSetId),
    articleLedger,
    undefined,
    headroomReader(["x"], deliveryLedger, articleLedger),
  ).run({ ids });
  console.log(`x-article: sent ${result.sent} · skipped ${result.skipped} (already posted) · failed ${result.failed}`);
  if (result.quotaBlocked) {
    const { needed, available, resetsAt } = result.quotaBlocked;
    // `available` (remaining − inFlight) can be negative when a stale in-flight row overcounts —
    // clamp only the displayed number; the refusal itself already happened on the raw comparison.
    console.warn(`⚠ x-article was not sent: this run needs ${needed} publish(es) and the account has ${Math.max(0, available)} left${resetsAt ? ` until ${resetsAt}` : ""}.`);
  }
} finally {
  await db.close();
}
