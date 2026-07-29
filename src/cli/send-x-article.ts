import "./registerErrorHandler";
import { argValue } from "./args";
import { paths } from "../paths";
import { loadTypefullyConfig } from "../config";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { JsonDeliveryLedger } from "../adapters/store/JsonDeliveryLedger";
import { TypefullyMedia } from "../adapters/send/TypefullyMedia";
import { TypefullyArticleSender } from "../adapters/send/TypefullyArticleSender";
import { xArticleMeta } from "../adapters/content/xArticleMeta";
import { SendXArticle } from "../app/SendXArticle";
import { headroomReader } from "./publishHeadroom";

const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const c = loadTypefullyConfig();
const articleLedger = new JsonXArticleLedger(paths.publishDir);
// Headroom spans both ledgers (x-post rooms and x-article), so this one-shot process constructs its
// own delivery ledger just to read from it. Unlike serve.ts, nothing else here shares this instance,
// so there is no second serializer chain to race.
const deliveryLedger = new JsonDeliveryLedger(paths.publishDir);
const result = await new SendXArticle(
  new JsonTranslationStore(paths.translationsDir),
  xArticleMeta(paths.xItems),
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
