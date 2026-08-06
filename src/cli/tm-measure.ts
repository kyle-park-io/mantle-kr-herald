import "./registerErrorHandler";
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { DEFAULT_MAX_PAGES, TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { formatMeasureReport } from "../domain/tm/measureReport";

// advanced_search yields ~20 tweets/page; the gateway caps a single run at DEFAULT_MAX_PAGES.
// Imported, not re-declared: this report's whole point is "will one `pnpm collect:reference` run
// fit inside the cap", and a local copy of 50 answers that question about a number the gateway may
// no longer use. This command never builds a raised gateway itself — it reports against the
// default, which is what an un-overridden collect will actually get.
const PAGE_SIZE = 20;

const handle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";
const target = process.argv[2]?.startsWith("--") ? handle : process.argv[2] ?? handle;

const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));
const profile = await gateway.fetchUserProfile(target);
console.log(formatMeasureReport(profile, PAGE_SIZE, DEFAULT_MAX_PAGES));
