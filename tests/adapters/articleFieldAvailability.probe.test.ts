import { describe, it, expect } from "vitest";
import { TwitterClient } from "../../src/adapters/twitterapi/TwitterClient";

const apiKey = process.env.TWITTERAPI_IO_KEY;

// Mantle_Official, "Phase 1: ClawHack, The Turing Test Hackathon Begins", posted 2026-04-10.
const ARTICLE_TWEET_ID = "2042617042537451733";

interface RawTweetsResponse {
  tweets?: unknown[];
}

function findById(tweets: unknown[], id: string): Record<string, unknown> | undefined {
  return tweets.find(
    (t): t is Record<string, unknown> => typeof t === "object" && t !== null && (t as Record<string, unknown>)["id"] === id,
  );
}

// Skipped unless a real API key is present (network + credits required).
//
// Pins the gap this branch's design relies on (see "Live verification" in
// docs/superpowers/specs/2026-07-23-x-article-support-design.md): `advanced_search` — the
// collection page endpoint — carries the `article` field on an Article tweet, but
// `thread_context` — the endpoint `CollectAuthoredContent.gapFillMissingRoots` uses to pull in a
// missing thread root — does not. That gap is why `LocalJsonStore.mergeTweets` must not let a
// gap-filled tweet's absent `article` field overwrite a previously stored article body.
describe.skipIf(!apiKey)("PROBE: article field availability by endpoint", () => {
  it("advanced_search carries `article` for a known article tweet; thread_context does not", async () => {
    const client = new TwitterClient(apiKey!);

    const searchData = await client.get<RawTweetsResponse>("/twitter/tweet/advanced_search", {
      // A tight time window around the known post date keeps this cheap and deterministic
      // instead of paging through the account's full history looking for one tweet.
      query: "from:Mantle_Official since_time:1775779200 until_time:1775865600",
      queryType: "Latest",
      cursor: "",
    });
    const searchTweets = searchData.tweets ?? [];
    const fromSearch = findById(searchTweets, ARTICLE_TWEET_ID);

    const threadData = await client.get<RawTweetsResponse>("/twitter/tweet/thread_context", {
      tweetId: ARTICLE_TWEET_ID,
      cursor: "",
    });
    const threadTweets = threadData.tweets ?? [];
    const fromThread = findById(threadTweets, ARTICLE_TWEET_ID);

    // eslint-disable-next-line no-console
    console.log(
      `[probe] advanced_search: ${searchTweets.length} tweets, target found=${fromSearch !== undefined}, ` +
        `has 'article' key=${fromSearch !== undefined && "article" in fromSearch}; ` +
        `thread_context: ${threadTweets.length} tweets, target found=${fromThread !== undefined}, ` +
        `has 'article' key=${fromThread !== undefined && "article" in fromThread}`,
    );

    expect(fromSearch).toBeDefined();
    expect(fromSearch !== undefined && "article" in fromSearch).toBe(true);

    expect(fromThread).toBeDefined();
    expect(fromThread !== undefined && "article" in fromThread).toBe(false);
  }, 60000); // live pagination over the network needs more than vitest's 5s default
});
