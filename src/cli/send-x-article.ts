import "./registerErrorHandler";
import { argValue } from "./args";
import { paths } from "../paths";
import { loadTypefullyConfig } from "../config";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { TypefullyMedia } from "../adapters/send/TypefullyMedia";
import { TypefullyArticleSender } from "../adapters/send/TypefullyArticleSender";
import { xArticleMeta } from "../adapters/content/xArticleMeta";
import { SendXArticle } from "../app/SendXArticle";

const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const c = loadTypefullyConfig();
const result = await new SendXArticle(
  new JsonTranslationStore(paths.translationsDir),
  xArticleMeta(paths.xItems),
  new TypefullyMedia(c.apiKey, c.socialSetId),
  new TypefullyArticleSender(c.apiKey, c.socialSetId),
  new JsonXArticleLedger(paths.publishDir),
).run({ ids });
console.log(`x-article: sent ${result.sent} · skipped ${result.skipped} (already posted) · failed ${result.failed}`);
