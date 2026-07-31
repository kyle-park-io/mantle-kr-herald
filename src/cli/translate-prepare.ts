import "./registerErrorHandler";
import { argValue } from "./args";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { FileTranslationConfig } from "../adapters/store/FileTranslationConfig";
import { PrepareTranslations, type Selector } from "../app/PrepareTranslations";
import type { ContentSource } from "../ports/ContentSource";
import { archiveFile } from "../shared/store/archive";
import { writeJsonFileAtomic } from "../shared/store/jsonFile";
import { paths } from "../paths";

const sourceArg = argValue("--source"); // "x" | "lark" | undefined (both)

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

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const source: ContentSource =
    sourceArg === "x" ? stores.xContentSource : sourceArg === "lark" ? stores.larkContentSource : stores.contentSource;

  const usecase = new PrepareTranslations(
    source,
    new JsonGlossaryStore(paths.translationConfigDir),
    stores.fewShotStore,
    new FileTranslationConfig(paths.translationConfigDir),
    stores.translationStore,
    new JsonFewShotStore(paths.translationConfigDir, "tm.json"),
  );

  const { worksheet, pending } = await usecase.run(selector);

  await mkdir(paths.translationsWorksheets, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const worksheetPath = join(paths.translationsWorksheets, `batch-${stamp}.md`);
  await writeFile(worksheetPath, worksheet, "utf8");

  const archived = await archiveFile(paths.translationsPending, paths.archiveDir, "pending-translations");
  if (archived) console.log(`  archived the previous unsaved batch → ${archived}`);
  await writeJsonFileAtomic(paths.translationsDir, paths.translationsPending, pending);

  console.log(`prepared ${pending.length} item(s) → ${worksheetPath}`);
  console.log("Translate each item's 원문 into the 번역 section, then run: pnpm translate:save --id <id> --file <korean.txt> [--approve]");
} finally {
  await db.close();
}
