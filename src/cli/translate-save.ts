import "./registerErrorHandler";
import { argValue } from "./args";
import { readFile } from "node:fs/promises";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { readJsonFile } from "../shared/store/jsonFile";
import type { ContentItem } from "../domain/translation/contentItem";
import { paths } from "../paths";

const id = argValue("--id");
const file = argValue("--file");
const approve = process.argv.includes("--approve");
if (!id || !file) {
  throw new Error("Usage: pnpm translate:save --id <itemId> --file <korean.txt> [--approve]");
}

const translationStore = new JsonTranslationStore(paths.translationsDir);

const pending = await readJsonFile<ContentItem[]>(paths.translationsPending, []);
let item = pending.find((p) => p.id === id);
if (!item) {
  // Not in the current worksheet batch — fall back to an already-saved translation, so you
  // can re-save or re-approve an item after pending.json was replaced by a later prepare.
  const saved = (await translationStore.loadAll()).find((t) => t.itemId === id);
  if (saved) {
    item = { id: saved.itemId, source: saved.source, text: saved.sourceText, createdAt: saved.translatedAt };
  }
}
if (!item) {
  throw new Error(`Item ${id} not found in ${paths.translationsPending} or the saved translations (run translate:prepare first)`);
}

const koreanText = (await readFile(file, "utf8")).trim();

const usecase = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir));
const res = await usecase.run({
  itemId: item.id,
  source: item.source,
  sourceText: item.text,
  koreanText,
  approve,
});

console.log(`saved ${res.itemId}${res.promoted ? " (approved → few-shot)" : ""}`);
