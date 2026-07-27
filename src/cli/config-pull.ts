import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleConfigDrive } from "../adapters/drive/GoogleConfigDrive";
import { FsConfigFileStore } from "../adapters/store/FsConfigFileStore";
import { PullConfig } from "../app/PullConfig";
import { loadGoogleAuthConfig, loadGoogleConfigFolder } from "../config";
import { paths, REPO_ROOT } from "../paths";

const folderId = loadGoogleConfigFolder();
if (!folderId) throw new Error("Set GDRIVE_CONFIG_FOLDER_ID (run `pnpm config:push` once to provision it).");

const dryRun = process.argv.includes("--dry-run");
const auth = await createGoogleAuth(loadGoogleAuthConfig());
const files = new FsConfigFileStore(
  [{ abs: paths.translationConfigDir, rel: "translation" }, { abs: paths.conversionConfigDir, rel: "conversion" }],
  REPO_ROOT,
);

const res = await new PullConfig(files, new GoogleConfigDrive(auth), paths.archiveDir).run(folderId, { dryRun });
if (!res) {
  console.log("no config snapshot on Drive — run `pnpm config:push` first");
} else if (res.dryRun) {
  const changed = res.changes.filter((c) => c.kind !== "same");
  console.log(changed.length === 0 ? "up to date (no changes)" : changed.map((c) => `  ${c.kind}: ${c.path}`).join("\n"));
} else {
  console.log(`pulled ${res.pulled} file(s)${res.backedUp > 0 ? ` — backed up ${res.backedUp} → ${res.backupDir}` : ""}`);
}
