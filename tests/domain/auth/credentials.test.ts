import { describe, it, expect, beforeAll } from "vitest";
import { checkCredentials } from "../../../src/domain/auth/credentials";
import { hashPassword } from "../../../src/domain/auth/password";

let account: { username: string; passwordHash: string };

beforeAll(async () => {
  account = { username: "herald", passwordHash: await hashPassword("open sesame") };
});

describe("credential check", () => {
  it("accepts the configured username and password", async () => {
    expect(await checkCredentials({ username: "herald", password: "open sesame" }, account)).toBe(true);
  });

  it("refuses the right username with the wrong password", async () => {
    expect(await checkCredentials({ username: "herald", password: "open sesamé" }, account)).toBe(false);
  });

  it("refuses an unknown username", async () => {
    expect(await checkCredentials({ username: "herald ", password: "open sesame" }, account)).toBe(false);
  });

  /**
   * The property this pins: a wrong username costs the same derivation a right one does, so the
   * response time never says "that account name exists". Adding an early
   * `if (!usernameMatches) return false` before the password check would answer in under a
   * millisecond and fail here.
   *
   * The floor is deliberately far below the ~300ms a derivation actually takes — this needs to
   * separate "did the work" from "returned instantly", not measure the machine.
   */
  it("spends a derivation on an unknown username rather than answering instantly", async () => {
    const started = performance.now();
    await checkCredentials({ username: "nobody", password: "open sesame" }, account);
    expect(performance.now() - started).toBeGreaterThan(50);
  });
});
