import { describe, it, expect, afterEach } from "vitest";
import { tryLoadAuthConfig, loadAuthConfig } from "../src/config";

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
   * Absent rather than throwing — this loader's own contract, for a caller with a reason to
   * tolerate it (see its doc comment). `loadAuthConfig()` below is what `serve.ts` actually calls,
   * and does throw.
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

describe("loadAuthConfig", () => {
  it("returns the configured account", () => {
    process.env.HERALD_AUTH_USERNAME = "herald";
    process.env.HERALD_AUTH_PASSWORD_HASH = "scrypt$65536$8$1$c2FsdA==$aGFzaA==";
    expect(loadAuthConfig()).toEqual({ username: "herald", passwordHash: "scrypt$65536$8$1$c2FsdA==$aGFzaA==" });
  });

  /**
   * The one behavior this task adds: `serve.ts` used to run loopback-only, where an absent account
   * was harmless. It no longer is — every other route sits behind the session gate this account is
   * the only way through, so a missing one must stop the server rather than serve a login screen
   * that refuses everyone, permanently, with no way to tell why from the screen itself.
   */
  it("throws, naming pnpm auth:hash, when no account is configured", () => {
    delete process.env.HERALD_AUTH_USERNAME;
    delete process.env.HERALD_AUTH_PASSWORD_HASH;
    expect(() => loadAuthConfig()).toThrow(/pnpm auth:hash/);
  });
});
