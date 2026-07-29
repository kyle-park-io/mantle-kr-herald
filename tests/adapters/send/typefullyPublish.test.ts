import { describe, it, expect } from "vitest";
import { parseTweetId, parseArticleId, scheduledPublishAt } from "../../../src/adapters/send/typefullyPublish";

describe("parse helpers", () => {
  it("parseTweetId extracts the id from a status url", () => {
    expect(parseTweetId("https://x.com/bcd_kyle/status/2082140526716084285")).toBe("2082140526716084285");
  });
  it("parseArticleId extracts the id from an article url", () => {
    expect(parseArticleId("https://x.com/i/article/123")).toBe("123");
  });
  it("both return undefined for a missing or non-matching url", () => {
    expect(parseTweetId(undefined)).toBeUndefined();
    expect(parseTweetId("https://typefully.com/t/abc")).toBeUndefined();
    expect(parseArticleId(undefined)).toBeUndefined();
  });
});

describe("parseArticleId — the shape Typefully actually returns", () => {
  /** Live value from draft 10097410 (social set 283589, 2026-07-29). */
  it("parses a /status/ article url", () => {
    expect(parseArticleId("https://x.com/bcd_kyle/status/2082141042959401225")).toBe("2082141042959401225");
  });

  it("still parses the /i/article/ form", () => {
    expect(parseArticleId("https://x.com/i/article/2082141")).toBe("2082141");
  });

  it("is undefined for a url with no id and for no url at all", () => {
    expect(parseArticleId("https://x.com/bcd_kyle")).toBeUndefined();
    expect(parseArticleId(undefined)).toBeUndefined();
  });
});

describe("scheduledPublishAt", () => {
  it("returns now + PUBLISH_DELAY_MS as ISO", () => {
    const at = 1_800_000_000_000;
    expect(scheduledPublishAt(() => at)).toBe(new Date(at + 2 * 60 * 1000).toISOString());
  });
});
