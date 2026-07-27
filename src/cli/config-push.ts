import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { FsConfigFileStore } from "../adapters/store/FsConfigFileStore";
import { PushConfig } from "../app/PushConfig";
import { loadGoogleAuthConfig, loadGoogleConfigFolder } from "../config";
import { paths, REPO_ROOT } from "../paths";

const CONFIG_FOLDER_NAME = "Mantle KR Herald — Steering Config";
const auth = await createGoogleAuth(loadGoogleAuthConfig());

let folderId = loadGoogleConfigFolder();
if (!folderId) {
  const prov = new GoogleDriveProvisioner(auth);
  const found = (await prov.findFolder(CONFIG_FOLDER_NAME)) ?? (await prov.createFolder(CONFIG_FOLDER_NAME));
  folderId = found.id;
  console.log(`provisioned config folder "${found.name}" (${found.id})`);
  console.log(`add this to your .env:  GDRIVE_CONFIG_FOLDER_ID=${found.id}`);
}

const files = new FsConfigFileStore(
  [{ abs: paths.translationConfigDir, rel: "translation" }, { abs: paths.conversionConfigDir, rel: "conversion" }],
  REPO_ROOT,
);
const res = await new PushConfig(files, new GoogleConfigDrive(auth)).run(folderId);
console.log(`pushed ${res.count} file(s) → ${res.name} (${res.id})`);
