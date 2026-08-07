import "./registerErrorHandler";
import { argValue } from "./args";
import { readFile } from "node:fs/promises";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
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

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const translationStore = stores.translationStore;

  const pending = await readJsonFile<ContentItem[]>(paths.translationsPending, []);
  let item = pending.find((p) => p.id === id);
  if (!item) {
    // Not in the current worksheet batch — fall back to an already-saved translation, so you
    // can re-save or re-approve an item after pending.json was replaced by a later prepare.
    const saved = (await translationStore.loadAll()).find((t) => t.itemId === id);
    if (saved) {
      item = { id: saved.itemId, source: saved.source, text: saved.sourceText, createdAt: saved.translatedAt, refUrl: saved.refUrl, isReply: saved.isReply };
    }
  }
  if (!item) {
    throw new Error(`Item ${id} not found in ${paths.translationsPending} or the saved translations (run translate:prepare first)`);
  }

  const koreanText = (await readFile(file, "utf8")).trim();

  const usecase = new SaveTranslation(translationStore, stores.fewShotStore, undefined, stores.lineageStore);
  const res = await usecase.run({
    itemId: item.id,
    source: item.source,
    sourceText: item.text,
    koreanText,
    approve,
    isReply: item.isReply,
    refUrl: item.refUrl,
  });

  // `approve` (the CLI flag), not `res.promoted`, is the approval signal: an oversized source
  // (an X Article) is approved but deliberately skipped for few-shot promotion (SaveTranslation's
  // MAX_FEW_SHOT_SOURCE_LENGTH gate), and that must not read as "not approved".
  let suffix = "";
  if (approve) {
    suffix = res.promoted ? " (approved → few-shot)" : " (approved; source too long for few-shot)";
  }
  // Reported, never refused (same reasoning as `checkGlossary`'s): the save is correct either way
  // because SaveTranslation already restored the label. Printing it is what keeps the rewrite from
  // being invisible again — it went unnoticed until someone happened to read a stored row.
  if (res.normalizedPhotoMarkers > 0) {
    suffix += ` (restored ${res.normalizedPhotoMarkers} [사진] marker(s) the translation rewrote)`;
  }
  console.log(`saved ${res.itemId}${suffix}`);
} finally {
  await db.close();
}
