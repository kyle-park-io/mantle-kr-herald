import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { GoogleAuth } from "../adapters/drive/GoogleAuth";
import { GoogleDriveUploader } from "../adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../adapters/drive/LarkDriveUploader";
import { JsonPublishStore } from "../adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { PublishTranslations } from "../app/PublishTranslations";
import { loadGoogleDriveConfig, loadLarkDriveConfig } from "../config";
import type { DriveUploader } from "../ports/DriveUploader";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = argValue("--target") ?? "both"; // google | lark | both
const uploaders: DriveUploader[] = [];

if (target === "google" || target === "both") {
  const g = loadGoogleDriveConfig();
  const auth = await GoogleAuth.fromKeyFile(g.saKeyFile);
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

const usecase = new PublishTranslations(new JsonTranslationStore("output"), uploaders, new JsonPublishStore("output"));
const result = await usecase.run();
console.log(`published ${result.uploaded} file(s) across ${uploaders.length} drive(s); ${result.failed} failure(s)`);
console.log(`  by drive: ${JSON.stringify(result.byDrive)}`);
