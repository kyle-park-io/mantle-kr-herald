import "./registerErrorHandler";
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { PublishTranslations } from "../app/PublishTranslations";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { SaveRendering } from "../app/SaveRendering";
import { ApproveRendering } from "../app/ApproveRendering";
import { loadStorageMode } from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import { REPO_ROOT, paths } from "../paths";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore(paths.translationsDir);
const publishStore = new JsonPublishStore(paths.publishDir);
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir));
const formattingStore = new JsonFormattingStore(paths.formattedDir);
const conversionStore = new JsonConversionStore(paths.variantsDir);

const storageMode = loadStorageMode();

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  buildPublisher: async (target) =>
    new PublishTranslations(translationStore, await createUploaders(resolveTargets(target, storageMode)), publishStore),
  storageMode,
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore),
  approveRendering: new ApproveRendering(formattingStore),
};

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist") });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);
