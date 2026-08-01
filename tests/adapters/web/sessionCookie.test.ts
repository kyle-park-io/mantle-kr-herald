// tests/adapters/web/sessionCookie.test.ts
import { describe, it, expect } from "vitest";
import { SESSION_COOKIE_NAME, buildSessionCookie, CLEARED_SESSION_COOKIE, readSessionToken } from "../../../src/adapters/web/sessionCookie";

/**
 * `sessionCookie.ts` is the sole reader of the credential on every request — `HttpServer.ts`'s
 * `currentSession()` calls `readSessionToken` on the raw `Cookie` header of every single API call.
 * These tests pin its correctness rather than find a bug; the parsing logic is already right.
 */
describe("readSessionToken", () => {
  it("reads the token out of a lone cookie", () => {
    expect(readSessionToken(`${SESSION_COOKIE_NAME}=abc.def`)).toBe("abc.def");
  });

  // The shape a real browser actually sends: several cookies on one line, the session cookie not
  // necessarily first or last.
  it("reads it out of a realistic multi-cookie header, wherever it falls", () => {
    expect(readSessionToken(`other=1; ${SESSION_COOKIE_NAME}=abc.def; third=x`)).toBe("abc.def");
    expect(readSessionToken(`${SESSION_COOKIE_NAME}=abc.def; other=1`)).toBe("abc.def");
    expect(readSessionToken(`other=1; third=x; ${SESSION_COOKIE_NAME}=abc.def`)).toBe("abc.def");
  });

  it("returns undefined when the cookie is simply absent", () => {
    expect(readSessionToken("other=1; third=x")).toBeUndefined();
  });

  it("returns undefined for an undefined or empty header", () => {
    expect(readSessionToken(undefined)).toBeUndefined();
    expect(readSessionToken("")).toBeUndefined();
  });

  // A pair with no `=` (a stray `;` typo, a malformed proxy header, ...) must be skipped, not throw
  // and not be mistaken for anything.
  it("skips a pair with no '=' instead of throwing or matching it", () => {
    expect(readSessionToken("malformed")).toBeUndefined();
    expect(readSessionToken(`malformed; ${SESSION_COOKIE_NAME}=abc.def`)).toBe("abc.def");
  });

  // Prefix/suffix collisions: the match is on the whole (trimmed) cookie name, not a substring —
  // `x_herald_session` and `herald_session_extra` both contain `herald_session` but are neither the
  // cookie this reads, and a substring match here would let an unrelated cookie be read as the
  // session token.
  it("does not match a cookie name that merely contains this one as a substring", () => {
    expect(readSessionToken(`x_${SESSION_COOKIE_NAME}=abc.def`)).toBeUndefined();
    expect(readSessionToken(`${SESSION_COOKIE_NAME}_extra=abc.def`)).toBeUndefined();
    // The real cookie can still be present alongside a colliding one — only the exact name matches.
    expect(readSessionToken(`x_${SESSION_COOKIE_NAME}=nope; ${SESSION_COOKIE_NAME}=abc.def`)).toBe("abc.def");
  });

  it("trims surrounding whitespace around the name and the value", () => {
    expect(readSessionToken(`  ${SESSION_COOKIE_NAME}  =  abc.def  ; other=1`)).toBe("abc.def");
  });
});

describe("buildSessionCookie", () => {
  it("carries the token and every required attribute", () => {
    const cookie = buildSessionCookie("tok.en", 12 * 60 * 60 * 1000);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=tok.en`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${12 * 60 * 60}`);
  });

  it("floors a sub-second ttlMs down to whole seconds for Max-Age", () => {
    expect(buildSessionCookie("tok.en", 1_500)).toContain("Max-Age=1;");
  });

  // What HttpServer's currentSession() has to parse back out of the header it just set.
  it("round-trips through readSessionToken", () => {
    const cookie = buildSessionCookie("tok.en", 1_000);
    const [pair] = cookie.split(";");
    expect(readSessionToken(pair)).toBe("tok.en");
  });
});

describe("CLEARED_SESSION_COOKIE", () => {
  it("clears immediately (Max-Age=0) and keeps the same security attributes", () => {
    expect(CLEARED_SESSION_COOKIE).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(CLEARED_SESSION_COOKIE).toContain("Max-Age=0");
    expect(CLEARED_SESSION_COOKIE).toContain("HttpOnly");
    expect(CLEARED_SESSION_COOKIE).toContain("Secure");
    expect(CLEARED_SESSION_COOKIE).toContain("SameSite=Lax");
  });

  it("reads back as an empty token, not the string 'undefined' or the literal name", () => {
    const [pair] = CLEARED_SESSION_COOKIE.split(";");
    expect(readSessionToken(pair)).toBe("");
  });
});
