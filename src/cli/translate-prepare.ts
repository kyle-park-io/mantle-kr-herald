import "./registerErrorHandler";
import { argValue } from "./args";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { PrepareTranslations, type Selector } from "../app/PrepareTranslations";
import type { ContentSource } from "../ports/ContentSource";
import { paths } from "../paths";

const sourceArg = argValue("--source"); // "x" | "lark" | undefined (both)
const xSource = new XContentSource(paths.xItems);
const larkSource = new LarkContentSource(paths.larkItems);
const source: ContentSource =
  sourceArg === "x" ? xSource : sourceArg === "lark" ? larkSource : new CompositeContentSource([xSource, larkSource]);

const selector: Selector = {};
const ids = argValue("--ids");
if (ids) selector.ids = ids.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
const since = argValue("--since");
if (since) selector.since = since;
const limit = argValue("--limit");
if (limit) {
  const n = Number(limit);
  if (Number.isFinite(n)) selector.limit = n;
}

const usecase = new PrepareTranslations(
  source,
  new JsonGlossaryStore(paths.translationConfigDir),
  new JsonFewShotStore(paths.translationConfigDir),
  new FileTranslationConfig(paths.translationConfigDir),
  new JsonTranslationStore(paths.translationsDir),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir(paths.translationsWorksheets, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join(paths.translationsWorksheets, `batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(
  paths.translationsPending,
  `${JSON.stringify(pending, null, 2)}\n`,
  "utf8",
);

console.log(`prepared ${pending.length} item(s) → ${worksheetPath}`);
console.log("Translate each item's 원문 into the 번역 section, then run: pnpm translate:save --id <id> --file <korean.txt> [--approve]");
