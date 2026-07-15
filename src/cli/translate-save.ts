import "./registerErrorHandler";
import { readFile } from "node:fs/promises";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { readJsonFile } from "../shared/store/jsonFile";
import type { ContentItem } from "../domain/translation/contentItem";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = argValue("--id");
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !file) {
  throw new Error("Usage: pnpm translate:save --id <itemId> --file <korean.txt> [--approve]");
}

const pending = await readJsonFile<ContentItem[]>("output/translations/pending.json", []);
const item = pending.find((p) => p.id === id);
if (!item) {
  throw new Error(`Item ${id} not found in output/translations/pending.json (run translate:prepare first)`);
}

const koreanText = (await readFile(file, "utf8")).trim();

const usecase = new SaveTranslation(new JsonTranslationStore("output/translations"), new JsonFewShotStore("translation"));
const res = await usecase.run({
  itemId: item.id,
  source: item.source,
  sourceText: item.text,
  koreanText,
  approve,
});

console.log(`saved ${res.itemId}${res.promoted ? " (approved → few-shot)" : ""}`);
