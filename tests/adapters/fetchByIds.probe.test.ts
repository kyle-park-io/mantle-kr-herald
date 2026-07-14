import { describe, it, expect } from "vitest";
import { TwitterClient } from "../../src/adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";

const apiKey = process.env.TWITTERAPI_IO_KEY;

// Skipped unless a real API key is present (network + credits required).
describe.skipIf(!apiKey)("PROBE: fetchByIds response shape for reconcile", () => {
  it("returns known-alive tweets for ids collected from authored search", async () => {
    const gw = new TwitterApiSourceGateway(new TwitterClient(apiKey!));

    const ids: string[] = [];
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official")) {
      ids.push(t.id);
      if (ids.length >= 5) break; // cap cost
    }

    const tweets = await gw.fetchByIds(ids);
    const idSet = new Set(ids);
    const returnedIds = tweets.map((t) => t.id);

    // eslint-disable-next-line no-console
    console.log(
      `[probe] requested ${ids.length} ids; fetchByIds returned ${tweets.length} tweets (subset check)`,
    );

    expect(returnedIds.every((id) => idSet.has(id))).toBe(true);
    expect(tweets.length).toBeGreaterThan(0);
  });
});
