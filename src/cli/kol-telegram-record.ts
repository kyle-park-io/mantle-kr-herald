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

// Mirrors metrics-record.ts: a past month is reachable only by paging back through everything newer,
// so a high-volume channel can hit the page cap before it reaches the month at all. The per-channel
// truncation counter in the summary below is what tells you whether that happened.
if (month !== currentMonth(new Date())) {
  console.warn(
    `[kol-telegram] ${month} is a past month — a channel that posts heavily may be truncated before the sweep reaches it (the preview pages newest-first and caps at maxPages). Check the "channel(s) truncated" count below. Current-month runs are exact.`,
  );
}

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);
const gateway = new TmePreviewGateway();

const map = await new LoadKolMap(sheet).run();
const renderings = await new JsonFormattingStore(paths.formattedDir).loadAll();
const candidates = telegramMatchCandidates(renderings);

const result = await new RecordKolTelegramPosts(sheet, gateway).run({ month, map, renderings: candidates });

// The "did anything happen?" guard. A run that read nothing at all otherwise prints a summary of
// five zeroes that looks exactly like a clean, successful month with no KOL coverage. Every way of
// getting here is a setup fault, not a quiet month: no `kol-map` row is marked active, or every
// row's tgHandle cell was unusable (each of those is named in a warning above).
if (result.channelsSwept === 0) {
  console.warn(
    `[kol-telegram] no channel was swept — nothing was read and nothing was written. ` +
      `'kol-map' has no row that is both active and carries a usable tgHandle. ` +
      `Set active to true on the contracted channels and check any handle warnings above; ` +
      `see docs/ko/kol-map-seed.md.`,
  );
}

// All five counters are always printed — a silent zero (e.g. channelsFailed or channelsTruncated
// omitted when 0) must never be mistaken for "no posts this month" when the real story is "every
// channel failed" or "a channel's sweep gave up before covering the month".
const failureCallout = result.channelsFailed > 0 ? " — see warnings above" : "";
const truncationCallout = result.channelsTruncated > 0 ? " — see warnings above" : "";
console.log(
  `kol-telegram posts recorded for ${month}: ${result.created} created, ${result.refreshed} refreshed, ` +
    `${result.channelsSwept} channel(s) swept, ${result.channelsFailed} channel(s) failed${failureCallout}, ` +
    `${result.channelsTruncated} channel(s) truncated${truncationCallout}.`,
);
