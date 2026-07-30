import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { argValue } from "./args";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { TmePreviewGateway } from "../adapters/telegram/TmePreviewGateway";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { LoadKolMap } from "../app/LoadKolMap";
import { RecordKolTelegramPosts } from "../app/RecordKolTelegramPosts";
import { telegramMatchCandidates } from "../app/telegramMatchCandidates";
import { currentMonth } from "../domain/metrics/window";
import { paths } from "../paths";

skipIfLocal("kol-telegram:record");

const month = argValue("--month") ?? currentMonth(new Date());

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TmePreviewGateway();

const map = await new LoadKolMap(sheet).run();
const renderings = await new JsonFormattingStore(paths.formattedDir).loadAll();
const candidates = telegramMatchCandidates(renderings);

const result = await new RecordKolTelegramPosts(sheet, gateway).run({ month, map, renderings: candidates });

// All four counters are always printed — a silent zero (e.g. channelsFailed omitted when 0) must
// never be mistaken for "no posts this month" when the real story is "every channel failed".
const failureCallout = result.channelsFailed > 0 ? " — see warnings above" : "";
console.log(
  `kol-telegram posts recorded for ${month}: ${result.created} created, ${result.refreshed} refreshed, ` +
    `${result.channelsSwept} channel(s) swept, ${result.channelsFailed} channel(s) failed${failureCallout}.`,
);
