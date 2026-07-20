import "./registerErrorHandler";
import { argValue } from "./args";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadStorageMode } from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import { paths } from "../paths";

// No skipIfLocal: in local mode publishing is not skipped, it targets the filesystem.
const targets = resolveTargets(argValue("--target"), loadStorageMode());
const uploaders = await createUploaders(targets);

const usecase = new PublishTranslations(
  new JsonTranslationStore(paths.translationsDir),
  uploaders,
  new JsonPublishStore(paths.publishDir),
);
const result = await usecase.run();
console.log(
  `published ${result.uploaded} new + ${result.updated} updated across ${uploaders.length} drive(s); ${result.failed} failure(s)`,
);
console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
if (targets.includes("local")) console.log(`  local files: ${paths.publishLocalDir}`);
for (const f of result.failures) console.error(`  ✗ ${f.key}: ${f.error}`);
if (result.failed > 0) process.exitCode = 1;
