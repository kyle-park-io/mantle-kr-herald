import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../../../src/domain/auth/password";

describe("password hashing", () => {
  it("verifies a password against a hash it produced", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", encoded)).toBe(true);
  });

  it("refuses a password that does not match", async () => {
    const encoded = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", encoded)).toBe(false);
  });

  it("salts, so the same password hashes to two different encodings", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  // A hand-edited or truncated HERALD_AUTH_PASSWORD_HASH must refuse the login, not crash the
  // endpoint: a 500 here would read as "the server is broken" instead of "that is not the password".
  it.each([
    ["not a hash at all", "hunter2"],
    ["an unknown algorithm", "bcrypt$65536$8$1$c2FsdA==$aGFzaA=="],
    ["non-numeric parameters", "scrypt$abc$8$1$c2FsdA==$aGFzaA=="],
    ["empty salt and key", "scrypt$65536$8$1$$"],
    ["a truncated encoding", "scrypt$65536$8$1$c2FsdA=="],
  ])("refuses %s", async (_label, encoded) => {
    await expect(verifyPassword("hunter2", encoded)).resolves.toBe(false);
  });
});
