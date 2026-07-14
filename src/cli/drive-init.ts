import { GoogleAuth } from "../adapters/drive/GoogleAuth";
import { GoogleDriveProvisioner } from "../adapters/drive/GoogleDriveProvisioner";
import { loadGoogleDriveInitConfig } from "../config";

const config = loadGoogleDriveInitConfig();
const auth = await GoogleAuth.fromKeyFile(config.saKeyFile);
const provisioner = new GoogleDriveProvisioner(auth);

const review = await provisioner.createFolder("Mantle KR — review");
const approved = await provisioner.createFolder("Mantle KR — approved");

for (const email of config.shareEmails) {
  await provisioner.share(review.id, email, "writer");
  await provisioner.share(approved.id, email, "writer");
}

console.log("Created Google Drive folders (owned by the service account).");
if (config.shareEmails.length > 0) {
  console.log(`Shared (editor) with: ${config.shareEmails.join(", ")}`);
} else {
  console.log("WARNING: GDRIVE_SHARE_EMAILS is empty — no one can see these folders yet. Set it and re-run, or share via API later.");
}
console.log("");
console.log("Put these in your .env:");
console.log(`GDRIVE_REVIEW_FOLDER_ID=${review.id}`);
console.log(`GDRIVE_APPROVED_FOLDER_ID=${approved.id}`);
