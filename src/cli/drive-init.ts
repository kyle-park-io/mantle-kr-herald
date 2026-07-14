import { GoogleAuth } from "../adapters/drive/GoogleAuth";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { loadGoogleDriveInitConfig } from "../config";

const force = process.argv.includes("--force");
const config = loadGoogleDriveInitConfig();
const auth = await GoogleAuth.fromKeyFile(config.saKeyFile);
const provisioner = new GoogleDriveProvisioner(auth);

async function ensureFolder(name: string): Promise<{ id: string; created: boolean }> {
  if (!force) {
    const existing = await provisioner.findFolder(name);
    if (existing) return { id: existing.id, created: false };
  }
  const created = await provisioner.createFolder(name);
  for (const email of config.shareEmails) {
    await provisioner.share(created.id, email, "writer");
  }
  return { id: created.id, created: true };
}

const review = await ensureFolder("Mantle KR — review");
const approved = await ensureFolder("Mantle KR — approved");

for (const [label, r] of [["review", review], ["approved", approved]] as const) {
  console.log(r.created ? `${label}: created + shared` : `${label}: already exists (reused; sharing unchanged)`);
}
if (config.shareEmails.length === 0) {
  console.log("WARNING: GDRIVE_SHARE_EMAILS is empty — newly created folders were not shared with anyone.");
}
console.log("");
console.log("Put these in your .env:");
console.log(`GDRIVE_REVIEW_FOLDER_ID=${review.id}`);
console.log(`GDRIVE_APPROVED_FOLDER_ID=${approved.id}`);
