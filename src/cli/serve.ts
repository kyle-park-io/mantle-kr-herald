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
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { HttpClient } from "../shared/http/HttpClient";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig, loadStorageMode } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";
import { paths } from "../paths";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore(paths.translationsDir);
const publishStore = new JsonPublishStore(paths.publishDir);
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore(paths.translationConfigDir));
const formattingStore = new JsonFormattingStore(paths.formattedDir);
const conversionStore = new JsonConversionStore(paths.variantsDir);

async function uploadersFor(target: string): Promise<DriveUploader[]> {
  // The dashboard's publish button is the same cloud write as `pnpm drive:publish`, so it obeys the
  // same storage mode. Throws rather than using skipIfLocal, whose process.exit(0) would kill the
  // running server; HttpServer turns this into a 500 carrying the message. The dashboard itself
  // stays available in local mode — only publishing is refused.
  if (loadStorageMode() === "local") {
    throw new Error("local mode — publishing is disabled (set HERALD_STORAGE_MODE=cloud to enable)");
  }

  const uploaders: DriveUploader[] = [];
  if (target === "google" || target === "both") {
    const g = loadGoogleDriveConfig();
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    uploaders.push(new GoogleDriveUploader(auth, { review: g.reviewFolderId, approved: g.approvedFolderId }));
  }
  if (target === "lark" || target === "both") {
    const l = loadLarkDriveConfig();
    const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
    uploaders.push(new LarkDriveUploader(auth, l.baseUrl, { review: l.reviewFolderToken, approved: l.approvedFolderToken }));
  }
  if (uploaders.length === 0) throw new Error(`Unknown publish target: ${target}`);
  return uploaders;
}

const deps: ApiDeps = {
  translationStore,
  saveTranslation,
  buildPublisher: async (target) => new PublishTranslations(translationStore, await uploadersFor(target), publishStore),
  formattingStore,
  conversionStore,
  saveRendering: new SaveRendering(formattingStore),
  approveRendering: new ApproveRendering(formattingStore),
};

startServer(deps, { port, staticDir: join("web", "dist") });
console.log(`Review dashboard on http://localhost:${port}  (build the UI first: pnpm build:web)`);
