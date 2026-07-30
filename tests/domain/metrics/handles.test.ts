import { describe, it, expect } from "vitest";
import { extractXHandle, extractTelegramHandle } from "../../../src/domain/metrics/handles";

describe("extractXHandle", () => {
  it("resolves an x.com / twitter.com URL when platform is X/Twitter", () => {
    expect(extractXHandle("X", "https://x.com/Mantle_KR")).toBe("Mantle_KR");
    expect(extractXHandle("Twitter", "https://twitter.com/foo?ref=1")).toBe("foo");
    expect(extractXHandle("x", "https://www.x.com/bar/")).toBe("bar");
  });
  it("resolves a bare @handle / handle when platform is X", () => {
    expect(extractXHandle("X", "@baz")).toBe("baz");
    expect(extractXHandle("X", "qux")).toBe("qux");
  });
  it("returns undefined when the platform is not X", () => {
    expect(extractXHandle("Telegram", "https://x.com/foo")).toBeUndefined();
  });
  it("returns undefined for a blank or non-X link", () => {
    expect(extractXHandle("X", "")).toBeUndefined();
    expect(extractXHandle("X", "https://t.me/foo")).toBeUndefined();
  });
  it("rejects a >15-char first path segment instead of truncating it", () => {
    expect(extractXHandle("X", "https://x.com/ThisHandleIsWayTooLong")).toBeUndefined();
  });
  it("resolves the handle from a profile URL with a trailing path", () => {
    expect(extractXHandle("X", "https://x.com/marine_x/status/123")).toBe("marine_x");
  });
});

describe("extractTelegramHandle", () => {
  it("reads a plain channel url", () => {
    expect(extractTelegramHandle("https://t.me/marshallog")).toBe("marshallog");
  });

  it("trims the stray whitespace the rate table actually contains", () => {
    // Both of these are real cell values in ' Q3 KOL 계약 리스트'.
    expect(extractTelegramHandle(" https://t.me/marshallog")).toBe("marshallog");
    expect(extractTelegramHandle("https://t.me/airdr0p_lab ")).toBe("airdr0p_lab");
  });

  it("reads the /s/ preview form", () => {
    expect(extractTelegramHandle("https://t.me/s/Raoni1")).toBe("Raoni1");
  });

  it("keeps handle case, since t.me paths are case-sensitive in practice", () => {
    expect(extractTelegramHandle("https://t.me/WeCryptoTogether")).toBe("WeCryptoTogether");
  });

  it("accepts a bare @handle", () => {
    expect(extractTelegramHandle("@coinboys")).toBe("coinboys");
  });

  it("ignores a trailing path, query, or fragment", () => {
    expect(extractTelegramHandle("https://t.me/GMBLABS/123")).toBe("GMBLABS");
    expect(extractTelegramHandle("https://t.me/GMBLABS?x=1")).toBe("GMBLABS");
  });

  it("rejects a non-telegram link, an invite link, and an empty cell", () => {
    expect(extractTelegramHandle("https://x.com/marshallog")).toBeUndefined();
    expect(extractTelegramHandle("https://t.me/+AbCdEf")).toBeUndefined();
    expect(extractTelegramHandle("")).toBeUndefined();
  });
});
