import { GoogleAuth } from "../adapters/drive/GoogleAuth";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { loadGoogleDriveInitConfig } from "../config";

const force = process.argv.includes("--force");
const config = loadGoogleDriveInitConfig();
const auth = await GoogleAuth.fromKeyFile(config.saKeyFile);
const provisioner = new GoogleDriveProvisioner(auth);

async function ensureFolder(
  name: string,
  parentId: string | undefined,
  share: boolean,
): Promise<{ id: string; created: boolean }> {
  if (!force) {
    const existing = await provisioner.findFolder(name, parentId);
    if (existing) return { id: existing.id, created: false };
  }
  const created = await provisioner.createFolder(name, parentId);
  if (share) {
    for (const email of config.shareEmails) {
      await provisioner.share(created.id, email, "writer");
    }
  }
  return { id: created.id, created: true };
}

// Parent folder is shared with the team; review/approved inherit its permissions.
const parent = await ensureFolder(config.parentFolderName, undefined, true);
const review = await ensureFolder("review", parent.id, false);
const approved = await ensureFolder("approved", parent.id, false);

console.log(`parent "${config.parentFolderName}": ${parent.created ? "created + shared" : "already exists (reused)"} → ${parent.id}`);
console.log(`  review:   ${review.created ? "created" : "already exists"} → ${review.id}`);
console.log(`  approved: ${approved.created ? "created" : "already exists"} → ${approved.id}`);
if (config.shareEmails.length === 0) {
  console.log("WARNING: GDRIVE_SHARE_EMAILS is empty — the parent folder was not shared with anyone.");
}
console.log("");
console.log("Put these in your .env:");
console.log(`GDRIVE_REVIEW_FOLDER_ID=${review.id}`);
console.log(`GDRIVE_APPROVED_FOLDER_ID=${approved.id}`);
