import { describe, it, expect } from "vitest";
import { computeCoverage } from "../../src/domain/coverage";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, createdAt: string): SourceTweet {
  return { id, conversationId: id, text: `t${id}`, createdAt, url: `u/${id}`,
    authorUserName: "Mantle_Official", isReply: false, isQuote: false };
}
const requested = { since: "2026-07-18T00:00:00.000Z", until: "2026-07-21T09:00:00.000Z" };

describe("computeCoverage", () => {
  it("covers min..max createdAt and reports no gap when not truncated", () => {
    const threads: AssembledThread[] = [
      { rootId: "a", tweets: [tw("a", "2026-07-19T00:00:00.000Z"), tw("a2", "2026-07-19T01:00:00.000Z")] },
      { rootId: "b", tweets: [tw("b", "2026-07-20T00:00:00.000Z")] },
    ];
    const c = computeCoverage(threads, requested, false);
    expect(c.covered).toEqual({ from: "2026-07-19T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" });
    expect(c.tweetCount).toBe(3);
    expect(c.gap).toBeNull();
  });

  it("reports a gap from requested.since to oldest covered when truncated", () => {
    const threads: AssembledThread[] = [
      { rootId: "b", tweets: [tw("b", "2026-07-20T00:00:00.000Z")] },
    ];
    const c = computeCoverage(threads, requested, true);
    expect(c.gap).toEqual({ from: "2026-07-18T00:00:00.000Z", to: "2026-07-20T00:00:00.000Z" });
  });

  it("returns null coverage when nothing was kept", () => {
    const c = computeCoverage([], requested, false);
    expect(c.covered).toBeNull();
    expect(c.tweetCount).toBe(0);
    expect(c.gap).toBeNull();
  });
});
