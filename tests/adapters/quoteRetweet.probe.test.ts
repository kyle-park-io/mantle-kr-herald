import { describe, it, expect } from "vitest";
import { TwitterClient } from "../../src/adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";

const apiKey = process.env.TWITTERAPI_IO_KEY;

// Skipped unless a real API key is present (network + credits required).
describe.skipIf(!apiKey)("PROBE: quote-retweet inclusion in authored search", () => {
  it("reports whether quote tweets appear in from:Mantle_Official", async () => {
    const gw = new TwitterApiSourceGateway(new TwitterClient(apiKey!));

    let total = 0;
    let quotes = 0;
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official")) {
      total += 1;
      if (t.isQuote) quotes += 1;
      if (total >= 50) break; // cap cost
    }

    // eslint-disable-next-line no-console
    console.log(`[probe] scanned ${total} authored tweets; ${quotes} are quote-tweets (isQuote=true)`);
    expect(total).toBeGreaterThan(0);
  }, 60000); // live pagination over the network needs more than vitest's 5s default
});
