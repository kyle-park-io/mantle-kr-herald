import { describe, it, expect } from "vitest";
import { expandUrls } from "../../../src/adapters/twitterapi/expandUrls";

describe("expandUrls", () => {
  it("replaces a t.co with its expanded_url", () => {
    expect(
      expandUrls("Trade here: https://t.co/abc", [{ url: "https://t.co/abc", expanded_url: "http://fluxion.network/trade" }]),
    ).toBe("Trade here: http://fluxion.network/trade");
  });

  it("strips a media t.co (no matching entity) with its attached whitespace", () => {
    expect(expandUrls("business as usual. https://t.co/vid", [])).toBe("business as usual.");
  });

  it("expands the real link and strips the media link in one text", () => {
    expect(
      expandUrls("See https://t.co/real and photo https://t.co/media", [
        { url: "https://t.co/real", expanded_url: "http://site.com/x" },
      ]),
    ).toBe("See http://site.com/x and photo");
  });

  it("keeps an X-self expanded_url (article/quote)", () => {
    expect(
      expandUrls("https://t.co/art", [{ url: "https://t.co/art", expanded_url: "http://x.com/i/article/1" }]),
    ).toBe("http://x.com/i/article/1");
  });

  it("skips an entity missing expanded_url, so its t.co is stripped as media", () => {
    expect(expandUrls("x https://t.co/bad", [{ url: "https://t.co/bad" }])).toBe("x");
  });

  it("expands multiple real links", () => {
    expect(
      expandUrls("a https://t.co/1 b https://t.co/2", [
        { url: "https://t.co/1", expanded_url: "http://one.com" },
        { url: "https://t.co/2", expanded_url: "http://two.com" },
      ]),
    ).toBe("a http://one.com b http://two.com");
  });

  it("returns text unchanged with no urls and no t.co", () => {
    expect(expandUrls("plain text", undefined)).toBe("plain text");
  });

  it("skips an entity with a null expanded_url, so its t.co is stripped as media", () => {
    expect(expandUrls("x https://t.co/a", [{ url: "https://t.co/a", expanded_url: null }])).toBe("x");
  });

  it("strips a leading media t.co and trims", () => {
    expect(expandUrls("https://t.co/vid hello", [])).toBe("hello");
  });
});
