import { describe, it, expect } from "vitest";
import { extractXHandle } from "../../../src/domain/metrics/handles";

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
});
