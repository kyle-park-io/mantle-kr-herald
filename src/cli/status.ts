import "./registerErrorHandler";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig, describeDbTarget } from "../config";
import { createStores } from "./stores";
import { pipelineStages, formatStatus } from "../status/pipeline";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { syncSummary, formatSyncSummary } from "../status/sync";

const cfg = loadDbConfig();
console.log(`database: ${cfg.env} · ${describeDbTarget(cfg)}`);

const db = createDb(cfg);
try {
  const stores = createStores(db);

  const collected = (await stores.contentSource.loadPending(new Set())).length;
  const translations = await stores.translationStore.loadAll();
  const variants = await stores.conversionStore.loadAll();
  const renderings = await stores.formattingStore.loadAll();
  const entries = await stores.publishStore.listEntries();
  // The funnel's "Published (drive)" counts ledger rows (one per upload target).
  const published = entries.length;

  console.log(formatStatus(pipelineStages({ collected, translations, variants, renderings, published })));
  // The sync line's "N published" counts unique translations with at least one ledger row.
  // These two numbers will diverge once multiple upload targets are enabled (e.g. Google and Lark).
  console.log(
    formatSyncSummary(
      syncSummary({
        translations,
        entries,
        render: (t) => (t.status === "approved" ? renderApproved(t) : renderReview(t)),
      }),
    ),
  );
} finally {
  await db.close();
}
