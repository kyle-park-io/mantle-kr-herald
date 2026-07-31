import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "../../../src/domain/auth/session";

const secret = "a".repeat(64);
const issued = new Date("2026-07-31T00:00:00.000Z");
const ttlMs = 12 * 60 * 60 * 1000;

describe("session tokens", () => {
  it("round-trips a payload", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    expect(verifySession(token, secret, issued)).toEqual({ issuedAt: issued.toISOString() });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    expect(verifySession(token, "b".repeat(64), issued)).toBeUndefined();
  });

  it("rejects a tampered payload", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ issuedAt: "2099-01-01T00:00:00.000Z" })).toString("base64url");
    expect(verifySession(`${forged}.${sig}`, secret, issued)).toBeUndefined();
    expect(body).not.toBe(forged);
  });

  it("rejects a token past its lifetime", () => {
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    const later = new Date(issued.getTime() + ttlMs + 1);
    expect(verifySession(token, secret, later)).toBeUndefined();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", ".", "no-dot", "a.b.c", "!!.??"]) {
      expect(() => verifySession(bad, secret, issued)).not.toThrow();
      expect(verifySession(bad, secret, issued)).toBeUndefined();
    }
  });
});
