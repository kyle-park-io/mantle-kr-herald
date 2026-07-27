import net from "node:net";
import { describe, it, expect } from "vitest";
import { preferIpv4 } from "../../src/cli/preferIpv4";

describe("preferIpv4", () => {
  it("disables Happy-Eyeballs family autoselection so fetch survives a broken IPv6 route", () => {
    // Simulate Node's default (autoselection on) and prove the bootstrap flips it.
    net.setDefaultAutoSelectFamily(true);
    preferIpv4();
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
  });
});
