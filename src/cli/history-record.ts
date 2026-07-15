import "./registerErrorHandler";
import { argValue } from "./args";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { RecordPublish } from "../app/RecordPublish";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";

const itemId = argValue("--item");
const type = argValue("--type");
const channel = argValue("--channel");
const status = argValue("--status");
if (!itemId || !type || !channel || !status) {
  throw new Error("Usage: pnpm history:record --item <id> --type <t> --channel <c> --status <s> [--post-id <p>] [--url <u>]");
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const { spreadsheetId } = loadGoogleSheetConfig();

await new RecordPublish(new GoogleSheetClient(auth, spreadsheetId)).record({
  itemId,
  type,
  channel,
  status,
  postId: argValue("--post-id"),
  url: argValue("--url"),
  publishedAt: new Date().toISOString(),
});

console.log(`recorded ${itemId}/${type}/${channel} (${status})`);
