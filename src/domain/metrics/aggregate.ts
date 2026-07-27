import type { SourceTweet } from "../models";
import type { MonthWindow } from "./window";

export interface MonthAggregate {
  posts: number;
  views: number;
  engagement: number;
}

export function aggregateMonth(tweets: SourceTweet[], window: MonthWindow): MonthAggregate {
  let posts = 0;
  let views = 0;
  let engagement = 0;
  for (const t of tweets) {
    if (t.createdAt < window.startISO || t.createdAt >= window.endExclusiveISO) continue;
    posts += 1;
    const m = t.metrics ?? {};
    views += m.viewCount ?? 0;
    engagement += (m.likeCount ?? 0) + (m.retweetCount ?? 0) + (m.replyCount ?? 0) + (m.quoteCount ?? 0);
  }
  return { posts, views, engagement };
}
