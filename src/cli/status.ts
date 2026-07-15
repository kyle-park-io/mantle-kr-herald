import "./registerErrorHandler";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { pipelineStages, formatStatus } from "../status/pipeline";

const source = new CompositeContentSource([
  new XContentSource("output/x/items.json"),
  new LarkContentSource("output/lark/items.json"),
]);

const collected = (await source.loadPending(new Set())).length;
const translations = await new JsonTranslationStore("output/translations").loadAll();
const variants = await new JsonConversionStore("output/variants").loadAll();
const renderings = await new JsonFormattingStore("output/formatted").loadAll();
const published = (await new JsonPublishStore("output/publish").listPublished()).size;

console.log(formatStatus(pipelineStages({ collected, translations, variants, renderings, published })));
