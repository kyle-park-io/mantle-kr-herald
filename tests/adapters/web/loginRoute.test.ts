import { describe, it, expect } from "vitest";
import { handleApi, type ApiDeps } from "../../../src/adapters/web/apiHandlers";
import type { LoginResult } from "../../../src/app/Login";

/**
 * The login route reads exactly one dep, so the rest of `ApiDeps` is left off rather than stubbed:
 * a hundred unused fields would bury what this test is about.
 */
function deps(result: LoginResult, seen: unknown[] = []): ApiDeps {
  return {
    login: async (credentials: { username: string; password: string }) => {
      seen.push(credentials);
      return result;
    },
  } as unknown as ApiDeps;
}

describe("POST /api/login", () => {
  it("answers 200 when the credentials are accepted", async () => {
    const res = await handleApi(deps({ ok: true }), "POST", "/api/login", { username: "herald", password: "pw" });
    expect(res).toEqual({ status: 200, json: { ok: true } });
  });

  it("forwards the supplied credentials unchanged", async () => {
    const seen: unknown[] = [];
    await handleApi(deps({ ok: true }, seen), "POST", "/api/login", { username: "herald", password: " pw " });
    expect(seen).toEqual([{ username: "herald", password: " pw " }]);
  });

  it("answers 401 when the credentials are refused", async () => {
    const res = await handleApi(deps({ ok: false, retryAfterMs: 0 }), "POST", "/api/login", { username: "a", password: "b" });
    expect(res.status).toBe(401);
  });

  it("answers 429 with the wait while the lockout holds", async () => {
    const res = await handleApi(deps({ ok: false, retryAfterMs: 42_000 }), "POST", "/api/login", { username: "a", password: "b" });
    expect(res).toEqual({ status: 429, json: { error: "너무 많이 시도했습니다. 잠시 후 다시 시도해 주세요.", retryAfterMs: 42_000 } });
  });

  /**
   * A refusal must not single out one half — naming the field tells someone probing when they have
   * found the account name, and there is only one to find. Mentioning both together is the point,
   * so the assertion is that the two are never separated: "비밀번호가 맞지 않습니다" would fail.
   */
  it("blames the pair rather than one half", async () => {
    const res = await handleApi(deps({ ok: false, retryAfterMs: 0 }), "POST", "/api/login", { username: "a", password: "b" });
    const message = (res.json as { error: string }).error;
    expect(message.includes("아이디")).toBe(message.includes("비밀번호"));
  });

  it.each([
    ["no body", undefined],
    ["a missing password", { username: "herald" }],
    ["a non-string password", { username: "herald", password: 1234 }],
  ])("answers 400 for %s, without consulting the credential check", async (_label, body) => {
    const seen: unknown[] = [];
    const res = await handleApi(deps({ ok: true }, seen), "POST", "/api/login", body);
    expect(res.status).toBe(400);
    expect(seen).toEqual([]);
  });
});
