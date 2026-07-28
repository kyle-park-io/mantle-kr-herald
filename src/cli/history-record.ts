import "./registerErrorHandler";
import { argValue } from "./args";
import { skipIfLocal } from "./skipIfLocal";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { RecordPublish } from "../app/RecordPublish";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { ALL_OUTLETS, outletById } from "../domain/outlet/models";

const itemId = argValue("--item");
const type = argValue("--type");
const channel = argValue("--channel");
const status = argValue("--status");
// Optional: a row's identity is (itemId, type, outletId), so recording a room by hand needs the
// room. Omitted = the pre-outlet row with a blank outletId, which is what legacy rows look like.
const outletId = argValue("--outlet");
const unknownOutlet = outletId !== undefined && outletById(outletId) === undefined;
skipIfLocal("history:record");
if (!itemId || !type || !channel || !status || unknownOutlet) {
  throw new Error(
    `Usage: pnpm history:record --item <id> --type <t> --channel <c> --status <s> [--outlet <${ALL_OUTLETS.map((o) => o.id).join("|")}>] [--post-id <p>] [--url <u>]`,
  );
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const { spreadsheetId } = loadGoogleSheetConfig();

await new RecordPublish(new GoogleSheetClient(auth, spreadsheetId)).record({
  itemId,
  type,
  channel,
  outletId,
  status,
  postId: argValue("--post-id"),
  url: argValue("--url"),
  publishedAt: new Date().toISOString(),
});

console.log(`recorded ${itemId}/${type}/${outletId ?? channel} (${status})`);
