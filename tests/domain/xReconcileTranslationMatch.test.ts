import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRANSLATION_MATCH_AT, bestThreadFor } from "../../src/domain/publish/xReconcile";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";

interface Pair {
  itemId: string;
  koreanText: string;
  topRootId: string;
  topLiveText: string;
  topPostedAt: string;
  measuredScore: number;
  runnerUpScore: number;
  samePost: boolean;
}
const { pairs } = JSON.parse(readFileSync("tests/fixtures/handPostedPairs.json", "utf8")) as { pairs: Pair[] };

/** One live thread carrying the fixture's captured text, so scores are reproducible offline. */
const threadOf = (rootId: string, text: string): AssembledThread => ({
  rootId,
  tweets: [
    {
      id: rootId,
      conversationId: rootId,
      text,
      createdAt: "2026-07-31T05:39:41.000Z",
      url: `https://x.com/0xMantleKR/status/${rootId}`,
      authorUserName: "0xMantleKR",
      isReply: false,
      isQuote: false,
    } satisfies SourceTweet,
  ],
});

describe("translation match against a hand-posted rewrite", () => {
  it("has five positives and four negatives in the fixture", () => {
    expect(pairs.filter((p) => p.samePost)).toHaveLength(5);
    expect(pairs.filter((p) => !p.samePost)).toHaveLength(4);
  });

  it("admits every labelled positive and rejects every labelled negative", () => {
    for (const p of pairs) {
      const best = bestThreadFor(p.koreanText, [threadOf(p.topRootId, p.topLiveText)]);
      expect(best, p.itemId).toBeDefined();
      expect(best!.score, `${p.itemId} score drifted from the 2026-08-07 measurement`).toBeCloseTo(p.measuredScore, 3);
      expect(best!.score >= TRANSLATION_MATCH_AT, `${p.itemId} (samePost=${p.samePost})`).toBe(p.samePost);
    }
  });

  // Pins the threshold from BOTH sides. Asserting only that 0.484 passes would still pass at a
  // threshold of 0.40, which is a test that cannot fail.
  it("sits between the lowest positive and the highest negative", () => {
    const minPositive = Math.min(...pairs.filter((p) => p.samePost).map((p) => p.measuredScore));
    const maxNegative = Math.max(...pairs.filter((p) => !p.samePost).map((p) => p.measuredScore));
    expect(minPositive).toBeCloseTo(0.3077, 3);
    expect(maxNegative).toBeCloseTo(0.0917, 3);
    expect(TRANSLATION_MATCH_AT).toBeGreaterThan(maxNegative);
    expect(TRANSLATION_MATCH_AT).toBeLessThan(minPositive);
  });

  it("picks the highest-scoring thread, not the first", () => {
    const target = pairs.find((p) => p.samePost)!;
    const decoy = pairs.find((p) => !p.samePost)!;
    const best = bestThreadFor(target.koreanText, [
      threadOf(decoy.topRootId, decoy.topLiveText),
      threadOf(target.topRootId, target.topLiveText),
    ]);
    expect(best!.thread.rootId).toBe(target.topRootId);
  });

  it("returns undefined when there are no threads", () => {
    expect(bestThreadFor("아무 텍스트", [])).toBeUndefined();
  });
});
