import { describe, it, expect } from "vitest";
import { signSession, verifySession, SESSION_TTL_MS } from "../../../src/domain/auth/session";

const secret = "a".repeat(64);
const issued = new Date("2026-07-31T00:00:00.000Z");
// Imported, not a second hardcoded literal: a test that copies the number rather than the constant
// would keep passing even if `SESSION_TTL_MS` drifted from what the cookie's `Max-Age` is built from
// (`sessionCookie.ts`'s `buildSessionCookie`, always called with `sessionConfig.ttlMs` —
// `apiHandlers.ts`'s login route), which is exactly the drift this file exists to catch.
const ttlMs = SESSION_TTL_MS;

describe("SESSION_TTL_MS", () => {
  it("is 2 hours — see the constant's own comment for why", () => {
    expect(SESSION_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});

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

  // `ttlMs` is a real parameter, not a label on `SESSION_TTL_MS` — a caller (`HttpServer.ts`'s
  // `currentSession()`) that passes a shorter lifetime gets it enforced, not silently ignored in
  // favor of the `SESSION_TTL_MS` default every other test in this file relies on.
  it("honors a ttlMs shorter than SESSION_TTL_MS rather than always falling back to it", () => {
    const shortTtlMs = 1_000;
    const token = signSession({ issuedAt: issued.toISOString() }, secret);
    const stillWithin = new Date(issued.getTime() + shortTtlMs - 1);
    const justPast = new Date(issued.getTime() + shortTtlMs + 1);
    expect(verifySession(token, secret, stillWithin, shortTtlMs)).toEqual({ issuedAt: issued.toISOString() });
    expect(verifySession(token, secret, justPast, shortTtlMs)).toBeUndefined();
  });
});
