import "./registerErrorHandler";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { pipelineStages, formatStatus } from "../status/pipeline";
import { paths } from "../paths";

const source = new CompositeContentSource([
  new XContentSource(paths.xItems),
  new LarkContentSource(paths.larkItems),
]);

const collected = (await source.loadPending(new Set())).length;
const translations = await new JsonTranslationStore(paths.translationsDir).loadAll();
const variants = await new JsonConversionStore(paths.variantsDir).loadAll();
const renderings = await new JsonFormattingStore(paths.formattedDir).loadAll();
const published = (await new JsonPublishStore(paths.publishDir).listPublished()).size;

console.log(formatStatus(pipelineStages({ collected, translations, variants, renderings, published })));
