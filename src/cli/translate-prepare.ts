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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sourceArg = argValue("--source"); // "x" | "lark" | undefined (both)
const xSource = new XContentSource("output/items.json");
const larkSource = new LarkContentSource("output/lark-items.json");
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
  new JsonGlossaryStore("data"),
  new JsonFewShotStore("data"),
  new FileTranslationConfig("data"),
  new JsonTranslationStore("output"),
);

const { worksheet, pending } = await usecase.run(selector);

await mkdir("output", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const worksheetPath = join("output", `translation-batch-${stamp}.md`);
await writeFile(worksheetPath, worksheet, "utf8");
await writeFile(
  join("output", "translation-pending.json"),
  `${JSON.stringify(pending, null, 2)}\n`,
  "utf8",
);

console.log(`prepared ${pending.length} item(s) → ${worksheetPath}`);
console.log("Translate each item's 원문 into the 번역 section, then run: pnpm translate:save --id <id> --file <korean.txt> [--approve]");
