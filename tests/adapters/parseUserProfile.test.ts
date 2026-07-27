import { describe, it, expect } from "vitest";
import { parseUserProfile } from "../../src/adapters/twitterapi/schemas";

describe("parseUserProfile", () => {
  it("reads statusesCount from data", () => {
    const got = parseUserProfile({ data: { userName: "0xMantleKR", statusesCount: 4316 } }, "fallback");
    expect(got).toEqual({ userName: "0xMantleKR", statusesCount: 4316 });
  });

  it("falls back to the requested handle and leaves count undefined when absent", () => {
    expect(parseUserProfile({ data: {} }, "0xMantleKR")).toEqual({ userName: "0xMantleKR", statusesCount: undefined });
  });

  it("tolerates a malformed response", () => {
    expect(parseUserProfile({ nope: true }, "0xMantleKR")).toEqual({ userName: "0xMantleKR", statusesCount: undefined });
  });

  it("captures followers when present, undefined when absent", () => {
    expect(parseUserProfile({ data: { userName: "0xMantleKR", statusesCount: 4317, followers: 4164 } }, "fb"))
      .toEqual({ userName: "0xMantleKR", statusesCount: 4317, followers: 4164 });
    expect(parseUserProfile({ data: { userName: "0xMantleKR" } }, "fb"))
      .toEqual({ userName: "0xMantleKR", statusesCount: undefined, followers: undefined });
  });
});
