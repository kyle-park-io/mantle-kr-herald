import { describe, it, expect } from "vitest";
import { assembleThreads } from "../../src/domain/threadAssembler";
import type { SourceTweet } from "../../src/domain/models";

function tweet(partial: Partial<SourceTweet> & { id: string }): SourceTweet {
  return {
    id: partial.id,
    conversationId: partial.conversationId ?? partial.id,
    text: partial.text ?? "text",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    url: partial.url ?? `https://x.com/Mantle_Official/status/${partial.id}`,
    authorUserName: partial.authorUserName ?? "Mantle_Official",
    isReply: partial.isReply ?? false,
    isQuote: partial.isQuote ?? false,
    media: partial.media,
    metrics: partial.metrics,
  };
}

describe("assembleThreads", () => {
  it("wraps a standalone tweet as a length-1 thread", () => {
    const result = assembleThreads([tweet({ id: "1" })]);
    expect(result).toEqual([{ rootId: "1", tweets: [expect.objectContaining({ id: "1" })] }]);
  });

  it("groups a self-thread by conversationId, sorted chronologically", () => {
    const t2 = tweet({ id: "2", conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" });
    const t1 = tweet({ id: "1", conversationId: "1", createdAt: "2026-01-01T00:01:00.000Z" });
    const result = assembleThreads([t2, t1]);
    expect(result).toHaveLength(1);
    expect(result[0].rootId).toBe("1");
    expect(result[0].tweets.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("dedups tweets by id (last wins)", () => {
    const result = assembleThreads([tweet({ id: "1", text: "old" }), tweet({ id: "1", text: "new" })]);
    expect(result).toHaveLength(1);
    expect(result[0].tweets).toHaveLength(1);
    expect(result[0].tweets[0].text).toBe("new");
  });

  it("returns separate threads ordered by earliest createdAt", () => {
    const a = tweet({ id: "10", createdAt: "2026-01-01T00:05:00.000Z" });
    const b = tweet({ id: "20", createdAt: "2026-01-01T00:01:00.000Z" });
    const result = assembleThreads([a, b]);
    expect(result.map((t) => t.rootId)).toEqual(["20", "10"]);
  });
});
