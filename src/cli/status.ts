import "./registerErrorHandler";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { pipelineStages, formatStatus } from "../status/pipeline";
import { renderApproved, renderReview } from "../domain/publish/renderers";
import { syncSummary, formatSyncSummary } from "../status/sync";
import { paths } from "../paths";
import { tryLoadStorageMode } from "../config";

const source = new CompositeContentSource([
  new XContentSource(paths.xItems),
  new LarkContentSource(paths.larkItems),
]);

const collected = (await source.loadPending(new Set())).length;
const translations = await new JsonTranslationStore(paths.translationsDir).loadAll();
const variants = await new JsonConversionStore(paths.variantsDir).loadAll();
const renderings = await new JsonFormattingStore(paths.formattedDir).loadAll();
const entries = await new JsonPublishStore(paths.publishDir).listEntries();
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
    tryLoadStorageMode(),
  ),
);
