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
import { loadGoogleAuthConfig, loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";

const port = Number(process.env.PORT) || 5757;
const translationStore = new JsonTranslationStore("output/translations");
const publishStore = new JsonPublishStore("output/publish");
const saveTranslation = new SaveTranslation(translationStore, new JsonFewShotStore("translation"));
const formattingStore = new JsonFormattingStore("output/formatted");
const conversionStore = new JsonConversionStore("output/variants");

async function uploadersFor(target: string): Promise<DriveUploader[]> {
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
