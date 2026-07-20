import "./registerErrorHandler";
import { argValue } from "./args";
import { skipIfLocal } from "./skipIfLocal";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { RecordImpressions } from "../app/RecordImpressions";
import { loadConfig, loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";

skipIfLocal("impressions:record");
const since = argValue("--since");

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const { spreadsheetId } = loadGoogleSheetConfig();
const sheet = new GoogleSheetClient(auth, spreadsheetId);
const source = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const result = await new RecordImpressions(sheet, source).run({ since });
console.log(`impressions: ${result.updated} updated · ${result.skipped} skipped · ${result.failed} failed`);
for (const f of result.failures) console.error(`  ✗ ${f.postId}: ${f.error}`);
if (result.failed > 0) process.exitCode = 1;
