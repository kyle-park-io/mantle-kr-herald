import "./registerErrorHandler";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TARGETS_HEADER, HISTORY_HEADER } from "../domain/sheet/models";
import { loadGoogleAuthConfig } from "../config";

const auth = await createGoogleAuth(loadGoogleAuthConfig());

// The spreadsheet doesn't exist yet, so this client is id-less; create returns the id.
const { spreadsheetId } = await new GoogleSheetClient(auth, "").createSpreadsheet("Mantle KR Herald — Data Hub", [
  { title: "targets" },
  { title: "history" },
]);

// Write the header rows into the two tabs.
const sheet = new GoogleSheetClient(auth, spreadsheetId);
await sheet.updateValues("targets!A1", [TARGETS_HEADER]);
await sheet.updateValues("history!A1", [HISTORY_HEADER]);

console.log(`created spreadsheet → ${spreadsheetId}`);
console.log("");
console.log("Put this in your .env:");
console.log(`GSHEET_ID=${spreadsheetId}`);
console.log("");
console.log("Notes: the sheet is owned by your Google account (OAuth) — share it with the team via the Sheets UI.");
console.log("If this failed with a scope/permission error, add the Sheets scope and re-mint the token:");
console.log('  GOOGLE_OAUTH_SCOPE="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets"  then  pnpm google:auth');
