import "./registerErrorHandler";
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { formatMeasureReport } from "../domain/tm/measureReport";

// advanced_search yields ~20 tweets/page; the gateway caps a single run at MAX_PAGES=50.
const PAGE_SIZE = 20;
const MAX_PAGES = 50;

const handle = process.env.REFERENCE_X_HANDLE?.trim() || "0xMantleKR";
const target = process.argv[2]?.startsWith("--") ? handle : process.argv[2] ?? handle;

const gateway = new TwitterApiSourceGateway(new TwitterClient(loadConfig().apiKey));
const profile = await gateway.fetchUserProfile(target);
console.log(formatMeasureReport(profile, PAGE_SIZE, MAX_PAGES));
