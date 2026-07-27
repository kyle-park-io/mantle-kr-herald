import { describe, it, expect } from "vitest";
import { aggregateMonth } from "../../../src/domain/metrics/aggregate";
import type { MonthWindow } from "../../../src/domain/metrics/window";
import type { SourceTweet } from "../../../src/domain/models";

const win: MonthWindow = { month: "2026-07", startISO: "2026-07-01T00:00:00.000Z", endExclusiveISO: "2026-08-01T00:00:00.000Z" };
const tw = (createdAt: string, metrics?: SourceTweet["metrics"]): SourceTweet =>
  ({ id: "1", conversationId: "1", createdAt, text: "", metrics } as SourceTweet);

describe("aggregateMonth", () => {
  it("counts posts and sums views + engagement within the window", () => {
    const got = aggregateMonth(
      [
        tw("2026-07-05T00:00:00.000Z", { viewCount: 100, likeCount: 3, retweetCount: 2, replyCount: 1, quoteCount: 1 }),
        tw("2026-07-20T00:00:00.000Z", { viewCount: 50, likeCount: 1 }),
      ],
      win,
    );
    expect(got).toEqual({ posts: 2, views: 150, engagement: 8 }); // 7 + 1
  });
  it("excludes tweets outside the window", () => {
    const got = aggregateMonth([tw("2026-06-30T23:59:59.000Z", { viewCount: 999 }), tw("2026-08-01T00:00:00.000Z", { viewCount: 999 })], win);
    expect(got).toEqual({ posts: 0, views: 0, engagement: 0 });
  });
  it("treats missing metric fields as zero", () => {
    expect(aggregateMonth([tw("2026-07-10T00:00:00.000Z")], win)).toEqual({ posts: 1, views: 0, engagement: 0 });
  });
  it("returns zeros for empty input", () => {
    expect(aggregateMonth([], win)).toEqual({ posts: 0, views: 0, engagement: 0 });
  });
  it("includes a tweet at exactly startISO (inclusive lower bound)", () => {
    expect(aggregateMonth([tw("2026-07-01T00:00:00.000Z", { viewCount: 5 })], win)).toEqual({ posts: 1, views: 5, engagement: 0 });
  });
});
