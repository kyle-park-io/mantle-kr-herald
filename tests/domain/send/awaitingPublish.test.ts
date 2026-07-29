import { describe, expect, it } from "vitest";
import { awaitingPublish, isXUrl } from "../../../src/domain/send/awaitingPublish";

const xRow = (over: Record<string, unknown> = {}) => ({
  itemId: "x:1", type: "x", outletId: "x-post", status: "sent", postId: "10104646", ...over,
});

describe("awaitingPublish", () => {
  /** What the ledger actually holds right after an X send: a Typefully draft id and no url. */
  it("is true for a sent X room still holding a draft id", () => {
    expect(awaitingPublish(xRow())).toBe(true);
  });

  it("is false once the row carries its x.com url", () => {
    expect(awaitingPublish(xRow({ url: "https://x.com/bcd_kyle/status/2082140526716084285" }))).toBe(false);
  });

  /** Telegram publishes immediately and answers with a t.me url — it is never in this state. */
  it("is false for a telegram room, url or not", () => {
    expect(awaitingPublish(xRow({ outletId: "tg-community", url: undefined }))).toBe(false);
    expect(awaitingPublish(xRow({ outletId: "tg-community", url: "https://t.me/c/999/11" }))).toBe(false);
  });

  it("is false for a manually ticked room — nothing was scheduled", () => {
    expect(awaitingPublish(xRow({ status: "delivered", postId: undefined }))).toBe(false);
  });

  it("is false with no postId to look up", () => {
    expect(awaitingPublish(xRow({ postId: undefined }))).toBe(false);
  });

  it("is false for a room that no longer exists", () => {
    expect(awaitingPublish(xRow({ outletId: "tg-retired" }))).toBe(false);
  });

  /** A t.me url is a url, but not the one that means "this X post is live". */
  it("isXUrl only accepts an x.com link", () => {
    expect(isXUrl("https://x.com/i/status/1")).toBe(true);
    expect(isXUrl("https://t.me/c/999/11")).toBe(false);
    expect(isXUrl(undefined)).toBe(false);
  });
});
