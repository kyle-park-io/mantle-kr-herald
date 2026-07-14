import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { GoogleServiceAccountAuth } from "../../../src/adapters/drive/GoogleServiceAccountAuth";
import { GoogleDriveUploader } from "../../../src/adapters/drive/GoogleDriveUploader";
import { LarkDriveUploader } from "../../../src/adapters/drive/LarkDriveUploader";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import { HttpClient } from "../../../src/shared/http/HttpClient";

const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;

// Skipped unless a Google service-account key file is configured.
describe.skipIf(!saKeyFile)("PROBE: Google service-account auth", () => {
  it("mints a real access token from the service account key", async () => {
    await readFile(saKeyFile!, "utf8"); // fail fast if unreadable
    const auth = await GoogleServiceAccountAuth.fromKeyFile(saKeyFile!);
    const token = await auth.getToken();
    // eslint-disable-next-line no-console
    console.log(`[probe] Google token acquired (len ${token.length})`);
    expect(token.length).toBeGreaterThan(0);
  }, 30000);
});

const gdriveReview = process.env.GDRIVE_REVIEW_FOLDER_ID;
const larkAppId = process.env.LARK_APP_ID;
const larkAppSecret = process.env.LARK_APP_SECRET;
const larkReviewToken = process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN;
const larkBase = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
const stamp = Date.now();

describe.skipIf(!saKeyFile || !gdriveReview)("PROBE: Google Drive upload", () => {
  it("uploads a throwaway markdown file to the review folder", async () => {
    const auth = await GoogleServiceAccountAuth.fromKeyFile(saKeyFile!);
    const uploader = new GoogleDriveUploader(auth, { review: gdriveReview!, approved: gdriveReview! });
    const res = await uploader.upload({ name: `probe-${stamp}.md`, content: "# probe", folder: "review" });
    // eslint-disable-next-line no-console
    console.log(`[probe] Google Drive uploaded id=${res.id}`);
    expect(res.id.length).toBeGreaterThan(0);
  }, 30000);
});

describe.skipIf(!larkAppId || !larkAppSecret || !larkReviewToken)("PROBE: Lark Drive upload", () => {
  it("uploads a throwaway markdown file to the review folder", async () => {
    const auth = new LarkAuth(new HttpClient(larkBase), larkAppId!, larkAppSecret!);
    const uploader = new LarkDriveUploader(auth, larkBase, { review: larkReviewToken!, approved: larkReviewToken! });
    const res = await uploader.upload({ name: `probe-${stamp}.md`, content: "# probe", folder: "review" });
    // eslint-disable-next-line no-console
    console.log(`[probe] Lark Drive uploaded id=${res.id}`);
    expect(res.id.length).toBeGreaterThan(0);
  }, 30000);
});
