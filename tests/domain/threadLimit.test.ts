import { describe, it, expect } from "vitest";
import { applyThreadLimit } from "../../src/domain/threadLimit";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, createdAt: string): SourceTweet {
  return { id, conversationId: id, text: `t${id}`, createdAt, url: `u/${id}`,
    authorUserName: "Mantle_Official", isReply: false, isQuote: false };
}
function thread(rootId: string, createdAt: string): AssembledThread {
  return { rootId, tweets: [tw(rootId, createdAt)] };
}

describe("applyThreadLimit", () => {
  const a = thread("a", "2026-07-19T00:00:00.000Z");
  const b = thread("b", "2026-07-20T00:00:00.000Z");
  const c = thread("c", "2026-07-21T00:00:00.000Z");

  it("keeps everything when limit is undefined", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], undefined);
    expect(kept).toHaveLength(3);
    expect(truncated).toBe(false);
  });
  it("keeps everything when limit >= count", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], 3);
    expect(truncated).toBe(false);
    expect(kept).toHaveLength(3);
  });
  it("keeps the newest N and marks truncated", () => {
    const { kept, truncated } = applyThreadLimit([a, b, c], 2);
    expect(truncated).toBe(true);
    expect(kept.map((t) => t.rootId)).toEqual(["c", "b"]);
  });
});
