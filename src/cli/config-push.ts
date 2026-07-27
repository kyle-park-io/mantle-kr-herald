import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { FsConfigFileStore } from "../adapters/store/FsConfigFileStore";
import { PushConfig } from "../app/PushConfig";
import { loadGoogleAuthConfig, loadGoogleConfigFolder } from "../config";
import { paths, REPO_ROOT } from "../paths";

// Nest under the same parent drive:init uses for review/approved, with a sibling-style short
// name (review · approved · steering-config), rather than a separate top-level folder.
const CONFIG_FOLDER_NAME = "steering-config";
const PARENT_FOLDER_NAME = process.env.GDRIVE_PARENT_FOLDER_NAME?.trim() || "Mantle KR Herald";
const auth = await createGoogleAuth(loadGoogleAuthConfig());

let folderId = loadGoogleConfigFolder();
if (!folderId) {
  const prov = new GoogleDriveProvisioner(auth);
  const parent = await prov.findFolder(PARENT_FOLDER_NAME); // undefined → fall back to the drive root
  const found =
    (await prov.findFolder(CONFIG_FOLDER_NAME, parent?.id)) ?? (await prov.createFolder(CONFIG_FOLDER_NAME, parent?.id));
  folderId = found.id;
  console.log(`provisioned config folder "${found.name}"${parent ? ` under "${parent.name}"` : ""} (${found.id})`);
  console.log(`add this to your .env:  GDRIVE_CONFIG_FOLDER_ID=${found.id}`);
}

const files = new FsConfigFileStore(
  [{ abs: paths.translationConfigDir, rel: "translation" }, { abs: paths.conversionConfigDir, rel: "conversion" }],
  REPO_ROOT,
);
const res = await new PushConfig(files, new GoogleConfigDrive(auth)).run(folderId);
console.log(`pushed ${res.count} file(s) → ${res.name} (${res.id})`);
