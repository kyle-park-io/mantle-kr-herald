import "./registerErrorHandler";
import { argValue } from "./args";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../adapters/db/createDb";
import { loadDbConfig } from "../config";
import { createStores } from "./stores";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { PrepareAlignment } from "../app/PrepareAlignment";
import type { Selector } from "../app/PrepareTranslations";
import { paths } from "../paths";

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
  const usecase = new PrepareAlignment(
    stores.translationStore,
    new JsonFewShotStore(paths.translationConfigDir, "tm.json"),
  );

  const { worksheet, aligned, skipped } = await usecase.run(selector);

  if (aligned === 0) {
    const hint = skipped > 0 ? " — run `pnpm tm:promote` to add precedent pairs" : "";
    console.log(`nothing to align · skipped ${skipped} (no precedent)${hint}`);
  } else {
    await mkdir(paths.translationsWorksheets, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const worksheetPath = join(paths.translationsWorksheets, `align-${stamp}.md`);
    await writeFile(worksheetPath, worksheet, "utf8");
    console.log(`aligned ${aligned} · skipped ${skipped} (no precedent) → ${worksheetPath}`);
    console.log("Revise each item's 현재 번역 into the 번역 section, then: pnpm translate:save --id <id> --file <korean.txt>");
  }
} finally {
  await db.close();
}
