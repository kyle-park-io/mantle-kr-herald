import "./registerErrorHandler";
import { argValue } from "./args";
import { createDb } from "../adapters/db/createDb";
import { createStores } from "./stores";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadStorageMode, loadDbConfig } from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import { paths } from "../paths";

// No skipIfLocal: in local mode publishing is not skipped, it targets the filesystem.
const targets = resolveTargets(argValue("--target"), loadStorageMode());
const uploaders = await createUploaders(targets);

const db = createDb(loadDbConfig());
try {
  const stores = createStores(db);
  const usecase = new PublishTranslations(stores.translationStore, uploaders, stores.publishStore);
  const result = await usecase.run();
  console.log(
    `published ${result.uploaded} new + ${result.updated} updated across ${uploaders.length} drive(s); ${result.failed} failure(s)`,
  );
  console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
  if (targets.includes("local")) console.log(`  local files: ${paths.publishLocalDir}`);
  for (const f of result.failures) console.error(`  ✗ ${f.key}: ${f.error}`);
  if (result.failed > 0) process.exitCode = 1;
} finally {
  await db.close();
}
