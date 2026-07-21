import { describe, it, expect } from "vitest";
import { parseSince } from "../../../src/shared/time/parseSince";

const NOW = new Date("2026-07-21T09:00:00.000Z");

describe("parseSince", () => {
  it("parses relative days", () => {
    expect(parseSince("3d", NOW)).toBe("2026-07-18T09:00:00.000Z");
  });
  it("parses relative hours", () => {
    expect(parseSince("12h", NOW)).toBe("2026-07-20T21:00:00.000Z");
  });
  it("parses relative weeks", () => {
    expect(parseSince("1w", NOW)).toBe("2026-07-14T09:00:00.000Z");
  });
  it("passes through an ISO date (midnight UTC)", () => {
    expect(parseSince("2026-07-18", NOW)).toBe("2026-07-18T00:00:00.000Z");
  });
  it("passes through an ISO datetime", () => {
    expect(parseSince("2026-07-18T09:30:00Z", NOW)).toBe("2026-07-18T09:30:00.000Z");
  });
  it("throws on a bare number with no unit", () => {
    expect(() => parseSince("3", NOW)).toThrow();
  });
  it("throws on an unsupported unit (minutes/months)", () => {
    expect(() => parseSince("5m", NOW)).toThrow();
  });
  it("throws on garbage", () => {
    expect(() => parseSince("banana", NOW)).toThrow();
  });
});
