import { describe, it, expect, afterEach } from "vitest";
import { tryLoadAuthConfig } from "../src/config";

const KEYS = ["HERALD_AUTH_USERNAME", "HERALD_AUTH_PASSWORD_HASH"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("tryLoadAuthConfig", () => {
  it("returns the configured account", () => {
    process.env.HERALD_AUTH_USERNAME = "herald";
    process.env.HERALD_AUTH_PASSWORD_HASH = "scrypt$65536$8$1$c2FsdA==$aGFzaA==";
    expect(tryLoadAuthConfig()).toEqual({ username: "herald", passwordHash: "scrypt$65536$8$1$c2FsdA==$aGFzaA==" });
  });

  /**
   * Absent rather than throwing: the dashboard predates having a credential and runs on loopback
   * without one, so an unset account must not stop the server from starting.
   */
  it.each([
    ["neither is set", undefined, undefined],
    ["only the username is set", "herald", undefined],
    ["only the hash is set", undefined, "scrypt$65536$8$1$c2FsdA==$aGFzaA=="],
    ["the username is blank", "   ", "scrypt$65536$8$1$c2FsdA==$aGFzaA=="],
  ])("is undefined when %s", (_label, username, hash) => {
    if (username === undefined) delete process.env.HERALD_AUTH_USERNAME;
    else process.env.HERALD_AUTH_USERNAME = username;
    if (hash === undefined) delete process.env.HERALD_AUTH_PASSWORD_HASH;
    else process.env.HERALD_AUTH_PASSWORD_HASH = hash;
    expect(tryLoadAuthConfig()).toBeUndefined();
  });
});
