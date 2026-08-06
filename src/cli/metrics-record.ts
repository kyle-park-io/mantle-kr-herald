import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadConfig, loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LoadRoster } from "../app/LoadRoster";
import { RecordMetrics } from "../app/RecordMetrics";
import { currentMonth } from "../domain/metrics/window";

skipIfLocal("metrics:record");

const month = argValue("--month") ?? currentMonth(new Date());
const officialHandle = process.env.REFERENCE_X_HANDLE?.trim().replace(/^@/, "") || "0xMantleKR";

if (month !== currentMonth(new Date())) {
  console.warn(
    `[metrics] ${month} is a past month — high-volume accounts may undercount (the fetch pages newest-first and caps at DEFAULT_MAX_PAGES). Current-month runs are exact.`,
  );
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));

const roster = await new LoadRoster(sheet).run();
const result = await new RecordMetrics(sheet, gateway).run({ month, officialHandle, roster });

console.log(
  `metrics recorded for ${month}: ${result.recorded} account(s), ${result.skipped} skipped ` +
    `(official @${officialHandle} + ${roster.length} X KOL(s)).`,
);
