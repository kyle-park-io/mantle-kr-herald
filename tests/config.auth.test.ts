import { describe, it, expect, afterEach } from "vitest";
import { tryLoadAuthConfig, loadAuthConfig } from "../src/config";
import { VALID_PASSWORD_HASH } from "./support/authFixtures";

/**
 * The fixture this replaced was `scrypt$65536$8$1$c2FsdA==$aGFzaA==` — a 4-byte salt and a 4-byte
 * key, which `verifyPassword` has always rejected outright. The loader accepted it, so these tests
 * asserted a configuration that could never authenticate anyone: the very disagreement between
 * loader and verifier that this file now pins shut.
 */
const VALID_HASH = VALID_PASSWORD_HASH;

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
    process.env.HERALD_AUTH_PASSWORD_HASH = VALID_HASH;
    expect(tryLoadAuthConfig()).toEqual({ username: "herald", passwordHash: VALID_HASH });
  });

  /**
   * Absent rather than throwing — this loader's own contract, for a caller with a reason to
   * tolerate it (see its doc comment). `loadAuthConfig()` below is what `serve.ts` actually calls,
   * and does throw.
   */
  it.each([
    ["neither is set", undefined, undefined],
    ["only the username is set", "herald", undefined],
    ["only the hash is set", undefined, VALID_HASH],
    ["the username is blank", "   ", VALID_HASH],
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
    process.env.HERALD_AUTH_PASSWORD_HASH = VALID_HASH;
    expect(loadAuthConfig()).toEqual({ username: "herald", passwordHash: VALID_HASH });
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

/**
 * The failure this closes: a `HERALD_AUTH_PASSWORD_HASH` that is set but unusable used to load fine.
 * `verifyPassword` then returned `false` for every password — so the app started, served a login
 * screen, and refused everyone forever with nothing anywhere saying why. On the production
 * deployment that hash is registered `sensitive`, so it cannot even be read back to compare against
 * a locally generated one; the only symptom was a 401 that looked identical to a typo.
 *
 * Absent stays tolerated. Present-and-broken is a misconfiguration, and it now says so at startup.
 */
describe("a malformed HERALD_AUTH_PASSWORD_HASH", () => {
  const MALFORMED: [string, string][] = [
    // What the shell does to `scrypt$65536$8$1$…` inside double quotes: `$8` and `$1` vanish.
    ["shell-expanded", "scrypt$65536$$$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="],
    ["truncated", "scrypt$65536$8$1$MDEyMzQ1Njc4OWFiY2RlZg=="],
    ["not scrypt at all", "the-password-itself"],
    // The hazard the decoder's own comment names: an empty key makes timingSafeEqual match anything.
    ["empty key", "scrypt$65536$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$"],
    // Structurally fine, cryptographically unusable — the shape of the old fixture.
    ["salt and key too short", "scrypt$65536$8$1$c2FsdA==$aGFzaA=="],
    ["N not a power of two", "scrypt$65537$8$1$MDEyMzQ1Njc4OWFiY2RlZg==$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="],
  ];

  it.each(MALFORMED)("is refused when %s", (_label, hash) => {
    process.env.HERALD_AUTH_USERNAME = "herald";
    process.env.HERALD_AUTH_PASSWORD_HASH = hash;
    expect(() => tryLoadAuthConfig()).toThrow(/HERALD_AUTH_PASSWORD_HASH/);
    expect(() => loadAuthConfig()).toThrow(/HERALD_AUTH_PASSWORD_HASH/);
  });

  it("names the shell as the likely cause, since that is what mangles it", () => {
    process.env.HERALD_AUTH_USERNAME = "herald";
    process.env.HERALD_AUTH_PASSWORD_HASH = "scrypt$65536$$$c2FsdA==$aGFzaA==";
    expect(() => loadAuthConfig()).toThrow(/shell|stdin/i);
  });

  /**
   * The loader must not be a second opinion about what a hash looks like. Anything it accepts,
   * `verifyPassword` has to be able to parse — otherwise this whole class of bug returns through
   * the gap between them.
   */
  it("accepts exactly what verifyPassword can parse", async () => {
    const { isPasswordHash } = await import("../src/domain/auth/password");
    for (const [, hash] of MALFORMED) expect(isPasswordHash(hash)).toBe(false);
    expect(isPasswordHash(VALID_HASH)).toBe(true);
  });
});
