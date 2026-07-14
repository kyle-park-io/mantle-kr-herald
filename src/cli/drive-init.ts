import { GoogleServiceAccountAuth } from "../adapters/drive/GoogleServiceAccountAuth";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { loadGoogleDriveInitConfig } from "../config";

const force = process.argv.includes("--force");
const config = loadGoogleDriveInitConfig();
const auth = await GoogleServiceAccountAuth.fromKeyFile(config.saKeyFile);
const provisioner = new GoogleDriveProvisioner(auth);

async function ensureFolder(
  name: string,
  parentId: string | undefined,
): Promise<{ id: string; created: boolean }> {
  if (!force) {
    const existing = await provisioner.findFolder(name, parentId);
    if (existing) return { id: existing.id, created: false };
  }
  const created = await provisioner.createFolder(name, parentId);
  return { id: created.id, created: true };
}

// Parent folder holds review/approved (they inherit its permissions), so only the parent is shared.
const parent = await ensureFolder(config.parentFolderName, undefined);
const review = await ensureFolder("review", parent.id);
const approved = await ensureFolder("approved", parent.id);

// Ensure the parent is shared with every configured email on EVERY run (idempotent — skip already-shared).
// This lets you run once with GDRIVE_SHARE_EMAILS empty, then fill it in and re-run to grant access.
let newlyShared = 0;
if (config.shareEmails.length > 0) {
  const alreadyShared = await provisioner.listSharedEmails(parent.id);
  for (const email of config.shareEmails) {
    if (!alreadyShared.has(email)) {
      await provisioner.share(parent.id, email, "writer");
      newlyShared++;
    }
  }
}

console.log(`parent "${config.parentFolderName}": ${parent.created ? "created" : "already exists (reused)"} → ${parent.id}`);
console.log(`  review:   ${review.created ? "created" : "already exists"} → ${review.id}`);
console.log(`  approved: ${approved.created ? "created" : "already exists"} → ${approved.id}`);
if (config.shareEmails.length === 0) {
  console.log("WARNING: GDRIVE_SHARE_EMAILS is empty — the parent folder was not shared with anyone.");
} else {
  console.log(`shared parent with ${config.shareEmails.length} email(s) as editor (${newlyShared} newly added, rest already had access).`);
}
console.log("");
console.log("Put these in your .env:");
console.log(`GDRIVE_REVIEW_FOLDER_ID=${review.id}`);
console.log(`GDRIVE_APPROVED_FOLDER_ID=${approved.id}`);
