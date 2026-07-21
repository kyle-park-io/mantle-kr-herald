import "./registerErrorHandler";
// src/cli/serve.ts
import { join } from "node:path";
import { startServer } from "../adapters/web/HttpServer";
import type { ApiDeps } from "../adapters/web/apiHandlers";
import type { StatusView, PublishStateRow } from "../adapters/web/apiHandlers";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonFewShotStore } from "../adapters/store/JsonFewShotStore";
import { SaveTranslation } from "../app/SaveTranslation";
import { PublishTranslations } from "../app/PublishTranslations";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonConversionStore } from "../adapters/store/JsonConversionStore";
import { SaveRendering } from "../app/SaveRendering";
import { ApproveRendering } from "../app/ApproveRendering";
import { loadStorageMode, loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import { createUploaders, resolveTargets } from "./uploaders";
import type { PublishResult } from "../app/PublishTranslations";
import { REPO_ROOT, paths } from "../paths";
import { XContentSource } from "../adapters/content/XContentSource";
import { LarkContentSource } from "../adapters/content/LarkContentSource";
import { CompositeContentSource } from "../adapters/content/CompositeContentSource";
import { syncSummary } from "../status/sync";
import { renderApproved, renderReview } from "../domain/publish/renderers";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore(paths.translationsDir);
const publishStore = new JsonPublishStore(paths.publishDir);
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir));
const formattingStore = new JsonFormattingStore(paths.formattedDir);
const conversionStore = new JsonConversionStore(paths.variantsDir);

const storageMode = loadStorageMode();

const usableTargets = ((): ("local" | "google" | "lark")[] => {
  const targets: ("local" | "google" | "lark")[] = ["local"];
  if (storageMode === "cloud") {
    try {
      loadGoogleAuthConfig();
      loadGoogleDriveConfig();
      targets.push("google");
    } catch {
      /* Google not configured — omit */
    }
    try {
      loadLarkDriveConfig();
      targets.push("lark");
    } catch {
      /* Lark not configured — omit */
    }
  }
  return targets;
})();

const contentSource = new CompositeContentSource([
  new XContentSource(paths.xItems),
  new LarkContentSource(paths.larkItems),
]);

const loadStatus = async (): Promise<StatusView> => {
  const [collected, translations, variants, renderings, entries] = await Promise.all([
    contentSource.loadPending(new Set()),
    translationStore.loadAll(),
    conversionStore.loadAll(),
    formattingStore.loadAll(),
    publishStore.listEntries(),
  ]);
  const sync = syncSummary({
    translations,
    entries,
    render: (t) => (t.status === "approved" ? renderApproved(t) : renderReview(t)),
  });
  return {
    storageMode,
    funnel: {
      collected: collected.length,
      translated: translations.length,
      converted: variants.length,
      rendered: renderings.length,
      published: entries.length,
    },
    sync,
    availableTargets: usableTargets,
  };
};

const publishOne = async (itemId: string, target: string): Promise<PublishResult> =>
  new PublishTranslations(
    translationStore,
    await createUploaders(resolveTargets(target, storageMode)),
    publishStore,
  ).run({ itemId });

const loadPublishState = async (): Promise<PublishStateRow[]> =>
  (await publishStore.listEntries()).map((e) => ({
    itemId: e.itemId,
    status: e.status,
    target: e.target,
    url: e.url,
    remoteId: e.remoteId,
    fileName: e.fileName,
  }));

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  publishOne,
  storageMode,
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore),
  approveRendering: new ApproveRendering(formattingStore),
  loadStatus,
  loadPublishState,
};

startServer(deps, { port, staticDir: join(REPO_ROOT, "web", "dist"), localPublishDir: paths.publishLocalDir });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);
