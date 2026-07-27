import { describe, it, expect } from "vitest";
import { resolveChannelTargets } from "../../src/cli/channelSenders";

describe("resolveChannelTargets", () => {
  it("defaults to all channels", () => {
    expect(resolveChannelTargets(undefined).sort()).toEqual(["telegram", "x"]);
  });
  it("expands 'both' to all channels", () => {
    expect(resolveChannelTargets("both").sort()).toEqual(["telegram", "x"]);
  });
  it("takes an explicit single channel", () => {
    expect(resolveChannelTargets("telegram")).toEqual(["telegram"]);
  });
  it("dedupes and rejects an unknown token", () => {
    expect(resolveChannelTargets("x,x")).toEqual(["x"]);
    expect(() => resolveChannelTargets("kakao")).toThrow(/Unknown channel target/);
  });
});
