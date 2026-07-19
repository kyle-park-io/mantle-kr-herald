import "./registerErrorHandler";
import { argValue } from "./args";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadGoogleDriveConfig, loadGoogleAuthConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";
import { paths } from "../paths";

const target = argValue("--target") ?? "google"; // google | lark | both (Lark is opt-in)
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
if (uploaders.length === 0) {
  throw new Error('No target selected. Use --target google|lark|both');
}

const usecase = new PublishTranslations(new JsonTranslationStore(paths.translationsDir), uploaders, new JsonPublishStore(paths.publishDir));
const result = await usecase.run();
console.log(`published ${result.uploaded} file(s) across ${uploaders.length} drive(s); ${result.failed} failure(s)`);
console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
for (const f of result.failures) console.error(`  ✗ ${f.key}: ${f.error}`);
if (result.failed > 0) process.exitCode = 1;
